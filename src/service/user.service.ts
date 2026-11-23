import { APIError } from 'better-auth/api';
import type { Auth } from '../auth/auth.js';
import type { AuthUser } from '../auth/auth-user.js';
import type { Database } from '../config/db.js';
import { toPage } from '../dto/common.dto.js';
import type { CreateUserInput, ListUsersQuery, UpdateMemberInput } from '../dto/user.dto.js';
import { ConflictError, NotFoundError, ValidationError } from '../exception/errors.js';
import type { MemberRepository, MemberView } from '../repository/member.repository.js';
import type { UserRepository } from '../repository/user.repository.js';
import type { AuditService } from './audit.service.js';
import { assertRole } from './policy.js';

/** API shape of an organization member. Credentials never leave the `account` table. */
export interface PublicUser {
  userId: string;
  tenantId: string;
  name: string;
  email: string;
  role: MemberView['role'];
  status: MemberView['status'];
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export const toPublicUser = (m: MemberView): PublicUser => ({
  userId: m.userId,
  tenantId: m.tenantId,
  name: m.name,
  email: m.email,
  role: m.role,
  status: m.status,
  emailVerified: m.emailVerified,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

/**
 * Sign-in / sessions belong to Better Auth (/api/auth/*). This service creates accounts (for registration and
 * invitations) and manages an organization's members: GET/POST/PATCH /users are the organization's team.
 */
export class UserService {
  constructor(
    private readonly db: Database,
    private readonly users: UserRepository,
    private readonly members: MemberRepository,
    private readonly audit: AuditService,
    private readonly auth: Auth,
  ) {}

  /**
   * Creates an account through Better Auth and signs it in. Returns the response headers (set-auth-token, cookies)
   * so the caller can hand the session to the client.
   */
  async createAccount(input: { name: string; email: string; password: string }): Promise<{ userId: string; headers: Headers }> {
    try {
      const { headers, response } = await this.auth.api.signUpEmail({
        body: { name: input.name, email: input.email, password: input.password },
        returnHeaders: true,
      });
      return { userId: response.user.id, headers };
    } catch (err) {
      if (err instanceof APIError) {
        const code = (err.body as { code?: string } | undefined)?.code ?? '';
        if (code.includes('USER_ALREADY_EXISTS')) throw new ConflictError('An account with this email already exists', 'EMAIL_TAKEN');
        throw new ValidationError(err.message || 'Could not create the account');
      }
      throw err;
    }
  }

  /** Undo a half-finished registration (the account exists but its organization or membership could not be saved). */
  deleteAccount(userId: string) {
    return this.users.deleteById(userId);
  }

  /** Admin-only: create a staff account and its membership directly (invitations are the alternative). */
  async createUser(actor: AuthUser, input: CreateUserInput): Promise<PublicUser> {
    assertRole(actor, 'ADMIN');
    const { userId } = await this.createAccount(input);
    try {
      return await this.db.transaction(async (tx) => {
        await this.members.upsert({ tenantId: actor.tenantId, userId, role: input.role }, tx);
        await this.audit.record(
          { tenantId: actor.tenantId, actorId: actor.id, action: 'USER_CREATED', entityType: 'USER', entityId: userId, metadata: { role: input.role } },
          tx,
        );
        const member = await this.members.findView(actor.tenantId, userId, tx);
        if (!member) throw new NotFoundError('User', userId);
        return toPublicUser(member);
      });
    } catch (err) {
      await this.deleteAccount(userId).catch(() => undefined);
      throw err;
    }
  }

  /** Members of the caller's organization only. */
  async getUserById(actor: AuthUser, id: string): Promise<PublicUser> {
    const member = await this.members.findView(actor.tenantId, id);
    if (!member) throw new NotFoundError('User', id);
    return toPublicUser(member);
  }

  /** The organization's team (e.g. to pick an assignee). */
  async listUsers(actor: AuthUser, q: ListUsersQuery) {
    const { items, total } = await this.members.list(actor.tenantId, {
      role: q.role,
      status: q.status,
      limit: q.pageSize,
      offset: (q.page - 1) * q.pageSize,
    });
    return toPage(items.map(toPublicUser), total, q);
  }

  /**
   * Admin-only: change a member's role or deactivate / re-activate them. A deactivated member loses access at
   * their next request. The organization always keeps at least one active admin.
   */
  async updateMember(actor: AuthUser, userId: string, input: UpdateMemberInput): Promise<PublicUser> {
    assertRole(actor, 'ADMIN');
    return this.db.transaction(async (tx) => {
      const admins = await this.members.lockActiveAdmins(actor.tenantId, tx);
      const current = await this.members.findForUpdate(actor.tenantId, userId, tx);
      if (!current) throw new NotFoundError('User', userId);

      const changes: UpdateMemberInput = {};
      if (input.role !== undefined && input.role !== current.role) changes.role = input.role;
      if (input.status !== undefined && input.status !== current.status) changes.status = input.status;

      const losesAdmin = current.role === 'ADMIN' && current.status === 'ACTIVE' && (changes.role === 'AGENT' || changes.status === 'DEACTIVATED');
      if (losesAdmin && admins.length <= 1) {
        throw new ConflictError('An organization needs at least one active admin', 'LAST_ADMIN');
      }

      if (Object.keys(changes).length > 0) {
        await this.members.update(actor.tenantId, userId, changes, tx);
        await this.audit.record(
          {
            tenantId: actor.tenantId,
            actorId: actor.id,
            action: changes.status === 'DEACTIVATED' ? 'MEMBER_DEACTIVATED' : changes.status === 'ACTIVE' ? 'MEMBER_REACTIVATED' : 'MEMBER_ROLE_CHANGED',
            entityType: 'USER',
            entityId: userId,
            metadata: { from: { role: current.role, status: current.status }, to: { role: changes.role ?? current.role, status: changes.status ?? current.status } },
          },
          tx,
        );
      }
      const member = await this.members.findView(actor.tenantId, userId, tx);
      return toPublicUser(member!);
    });
  }
}
