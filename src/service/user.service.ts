import { APIError } from 'better-auth/api';
import type { Auth } from '../auth/auth.js';
import type { AuthUser } from '../auth/auth-user.js';
import type { Database } from '../config/db.js';
import { toPage } from '../dto/common.dto.js';
import type { CreateUserInput, ListUsersQuery } from '../dto/user.dto.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../exception/errors.js';
import type { User } from '../model/schema.js';
import type { UserRepository } from '../repository/user.repository.js';
import type { AuditService } from './audit.service.js';
import { assertRole } from './policy.js';

/** API shape of a user. Credentials never leave the `account` table. */
export interface PublicUser {
  userId: string;
  tenantId: string;
  name: string;
  email: string;
  role: User['role'];
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export const toPublicUser = (u: User): PublicUser => ({
  userId: u.id,
  tenantId: u.tenantId,
  name: u.name,
  email: u.email,
  role: u.role,
  emailVerified: u.emailVerified,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
});

/**
 * Sign-up / sign-in / sessions belong to Better Auth (/api/auth/*).
 * This service covers app-level user operations: onboarding staff, lookup and listing (always within one tenant).
 */
export class UserService {
  constructor(
    private readonly db: Database,
    private readonly users: UserRepository,
    private readonly audit: AuditService,
    private readonly auth: Auth,
  ) {}

  /**
   * Admin-only. Better Auth creates the identity + credentials in the admin's tenant (always as CUSTOMER),
   * then the role is raised here. If that fails the account stays a CUSTOMER (least privilege).
   */
  async createUser(actor: AuthUser, input: CreateUserInput): Promise<PublicUser> {
    assertRole(actor, 'ADMIN');
    let createdId: string;
    try {
      const res = await this.auth.api.signUpEmail({
        body: { name: input.name, email: input.email, password: input.password, tenantId: actor.tenantId },
      });
      createdId = res.user.id;
    } catch (err) {
      if (err instanceof APIError) {
        const code = (err.body as { code?: string } | undefined)?.code ?? '';
        if (code.includes('USER_ALREADY_EXISTS')) throw new ConflictError('A user with this email already exists', 'EMAIL_TAKEN');
        throw new ValidationError(err.message || 'Could not create user');
      }
      throw err;
    }
    return this.db.transaction(async (tx) => {
      const user =
        input.role === 'CUSTOMER'
          ? await this.users.findById(actor.tenantId, createdId, tx)
          : await this.users.setRole(actor.tenantId, createdId, input.role, tx);
      if (!user) throw new NotFoundError('User', createdId);
      await this.audit.record(
        { tenantId: actor.tenantId, actorId: actor.id, action: 'USER_CREATED', entityType: 'USER', entityId: user.id, metadata: { role: user.role } },
        tx,
      );
      return toPublicUser(user);
    });
  }

  /** Staff can look up anyone in their tenant; customers only themselves. */
  async getUserById(actor: AuthUser, id: string): Promise<PublicUser> {
    if (actor.role === 'CUSTOMER' && actor.id !== id) throw new ForbiddenError();
    const user = await this.users.findById(actor.tenantId, id);
    if (!user) throw new NotFoundError('User', id);
    return toPublicUser(user);
  }

  /** List users in the tenant (e.g. to pick an assignee): staff only. */
  async listUsers(actor: AuthUser, q: ListUsersQuery) {
    assertRole(actor, 'AGENT', 'ADMIN');
    const { items, total } = await this.users.list(actor.tenantId, { role: q.role, limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    return toPage(items.map(toPublicUser), total, q);
  }
}