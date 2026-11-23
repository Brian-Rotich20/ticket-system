import type { AuthUser, SessionUser } from '../auth/auth-user.js';
import type { Database } from '../config/db.js';
import { toPage, type PaginationQuery } from '../dto/common.dto.js';
import type { AcceptInvitationInput, CreateInvitationInput } from '../dto/organization.dto.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../exception/errors.js';
import type { Invitation } from '../model/schema.js';
import type { InvitationRepository, InvitationView } from '../repository/invitation.repository.js';
import type { MemberRepository } from '../repository/member.repository.js';
import type { TenantRepository } from '../repository/tenant.repository.js';
import type { UserRepository } from '../repository/user.repository.js';
import type { AuditService } from './audit.service.js';
import type { NotificationService } from './notification.service.js';
import { assertRole } from './policy.js';
import { addDays, generateToken, hashToken, isWellFormedToken } from './secure-token.js';
import type { UserService } from './user.service.js';

/** Same answer for malformed, unknown, expired, revoked and already-used tokens. */
export class InvitationInvalidError extends AppError {
  constructor() {
    super(404, 'INVITATION_INVALID', 'This invitation is invalid, has expired or was already used. Ask your admin for a new one.');
  }
}

/** PENDING invitations past their expiry are shown as EXPIRED (they can no longer be accepted). */
export type InvitationListItem = Omit<InvitationView, 'status'> & { status: InvitationView['status'] | 'EXPIRED' };
const withEffectiveStatus = (i: InvitationView, now = new Date()): InvitationListItem => ({
  ...i,
  status: i.status === 'PENDING' && i.expiresAt <= now ? 'EXPIRED' : i.status,
});
const isUsable = (i: Invitation, now = new Date()) => i.status === 'PENDING' && i.expiresAt > now;

export class InvitationService {
  constructor(
    private readonly db: Database,
    private readonly invitations: InvitationRepository,
    private readonly members: MemberRepository,
    private readonly tenants: TenantRepository,
    private readonly users: UserRepository,
    private readonly userService: UserService,
    private readonly audit: AuditService,
    private readonly notifier: NotificationService,
    private readonly opts: { ttlDays: number; appUrl?: string },
  ) {}

  /** Admin-only. Re-inviting an e-mail replaces its pending invitation. The raw token is returned once. */
  async createInvitation(actor: AuthUser, input: CreateInvitationInput) {
    assertRole(actor, 'ADMIN');
    const existing = await this.members.findByEmail(actor.tenantId, input.email);
    if (existing?.status === 'ACTIVE') throw new ConflictError('This person is already a member of the organization', 'ALREADY_MEMBER');

    const { token, hash } = generateToken();
    const invitation = await this.db.transaction(async (tx) => {
      await this.invitations.revokePending(actor.tenantId, input.email, tx);
      const row = await this.invitations.insert(
        { tenantId: actor.tenantId, email: input.email, role: input.role, tokenHash: hash, expiresAt: addDays(new Date(), this.opts.ttlDays), invitedBy: actor.id },
        tx,
      );
      await this.audit.record(
        { tenantId: actor.tenantId, actorId: actor.id, action: 'INVITATION_CREATED', entityType: 'INVITATION', entityId: row.invitationId, metadata: { email: row.email, role: row.role } },
        tx,
      );
      return (await this.invitations.findViewById(actor.tenantId, row.invitationId, tx))!;
    });

    const path = `/accept-invitation/${token}`;
    const url = this.opts.appUrl ? `${this.opts.appUrl.replace(/\/+$/, '')}${path}` : null;
    const organization = await this.tenants.findById(actor.tenantId);
    this.notifier.notifyInvitation(invitation.email, organization?.name ?? actor.tenantId, actor.name, url ?? path);
    return { invitation: withEffectiveStatus(invitation), token, path, url };
  }

  async listInvitations(actor: AuthUser, p: PaginationQuery) {
    assertRole(actor, 'ADMIN');
    const { items, total } = await this.invitations.list(actor.tenantId, { limit: p.pageSize, offset: (p.page - 1) * p.pageSize });
    return toPage(items.map((i) => withEffectiveStatus(i)), total, p);
  }

  async revokeInvitation(actor: AuthUser, invitationId: number): Promise<void> {
    assertRole(actor, 'ADMIN');
    await this.db.transaction(async (tx) => {
      const inv = await this.invitations.findById(actor.tenantId, invitationId, tx);
      if (!inv) throw new NotFoundError('Invitation', invitationId);
      if (inv.status !== 'PENDING') throw new ConflictError(`The invitation is already ${inv.status.toLowerCase()}`, 'INVITATION_NOT_PENDING');
      await this.invitations.setStatus(actor.tenantId, invitationId, { status: 'REVOKED' }, tx);
      await this.audit.record(
        { tenantId: actor.tenantId, actorId: actor.id, action: 'INVITATION_REVOKED', entityType: 'INVITATION', entityId: invitationId, metadata: { email: inv.email } },
        tx,
      );
    });
  }

  /** Public: what the acceptance page shows. */
  async getPublicInvitation(rawToken: string) {
    const found = await this.lookup(rawToken);
    return {
      organization: { name: found.organizationName, logo: found.organizationLogo },
      email: found.invitation.email,
      role: found.invitation.role,
      expiresAt: found.invitation.expiresAt,
      /** true: sign in with this e-mail first, then accept. false: accept with a name and password. */
      accountExists: !!(await this.users.findByEmail(found.invitation.email)),
    };
  }

  /**
   * Accept: a signed-in invitee (same e-mail) just joins; someone without an account creates one with the
   * invitation's e-mail. Membership and the invitation status change together; a new account is removed again
   * if joining fails.
   */
  async acceptInvitation(rawToken: string, session: SessionUser | null, input: AcceptInvitationInput) {
    const { invitation } = await this.lookup(rawToken);

    let userId: string;
    let headers: Headers | null = null;
    let createdAccount = false;
    if (session) {
      if (session.email.toLowerCase() !== invitation.email) throw new ForbiddenError('This invitation was sent to a different e-mail address');
      userId = session.id;
    } else {
      if (await this.users.findByEmail(invitation.email)) {
        throw new ConflictError('An account with this e-mail already exists. Sign in, then accept the invitation.', 'ACCOUNT_EXISTS');
      }
      if (!input.name || !input.password) throw new ValidationError('Enter your name and a password to create your account');
      ({ userId, headers } = await this.userService.createAccount({ name: input.name, email: invitation.email, password: input.password }));
      createdAccount = true;
    }

    try {
      const membership = await this.db.transaction(async (tx) => {
        const locked = await this.invitations.findByTokenHashForUpdate(invitation.tokenHash, tx);
        if (!locked || !isUsable(locked)) throw new InvitationInvalidError(); // accepted / revoked meanwhile
        const member = await this.members.upsert({ tenantId: locked.tenantId, userId, role: locked.role }, tx);
        await this.invitations.setStatus(locked.tenantId, locked.invitationId, { status: 'ACCEPTED', acceptedBy: userId, acceptedAt: new Date() }, tx);
        await this.audit.record(
          { tenantId: locked.tenantId, actorId: userId, action: 'INVITATION_ACCEPTED', entityType: 'INVITATION', entityId: locked.invitationId, metadata: { email: locked.email, role: locked.role } },
          tx,
        );
        return member;
      });
      const organization = await this.tenants.findById(membership.tenantId);
      return {
        headers,
        body: { organization: { id: membership.tenantId, name: organization?.name ?? '', logo: organization?.logo ?? null, role: membership.role } },
      };
    } catch (err) {
      if (createdAccount) await this.userService.deleteAccount(userId).catch(() => undefined);
      throw err;
    }
  }

  private async lookup(rawToken: string) {
    if (!isWellFormedToken(rawToken)) throw new InvitationInvalidError();
    const found = await this.invitations.findByTokenHash(hashToken(rawToken));
    if (!found || !isUsable(found.invitation)) throw new InvitationInvalidError();
    return found;
  }
}
