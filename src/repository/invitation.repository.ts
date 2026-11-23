import { and, count, desc, eq } from 'drizzle-orm';
import type { Database, Executor } from '../config/db.js';
import type { MemberRole } from '../model/enums.js';
import { invitations, tenants, users, type Invitation } from '../model/schema.js';

export type InvitationView = Omit<Invitation, 'tokenHash'> & { invitedByName: string };

const view = {
  invitationId: invitations.invitationId,
  tenantId: invitations.tenantId,
  email: invitations.email,
  role: invitations.role,
  status: invitations.status,
  expiresAt: invitations.expiresAt,
  invitedBy: invitations.invitedBy,
  acceptedBy: invitations.acceptedBy,
  acceptedAt: invitations.acceptedAt,
  createdAt: invitations.createdAt,
  invitedByName: users.name,
};

export class InvitationRepository {
  constructor(private readonly db: Database) {}

  async insert(
    values: { tenantId: string; email: string; role: MemberRole; tokenHash: string; expiresAt: Date; invitedBy: string },
    ex: Executor = this.db,
  ): Promise<Invitation> {
    const [row] = await ex.insert(invitations).values(values).returning();
    return row!;
  }

  async findById(tenantId: string, id: number, ex: Executor = this.db): Promise<Invitation | null> {
    const [row] = await ex
      .select()
      .from(invitations)
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.invitationId, id)))
      .limit(1);
    return row ?? null;
  }

  async findViewById(tenantId: string, id: number, ex: Executor = this.db): Promise<InvitationView | null> {
    const [row] = await ex
      .select(view)
      .from(invitations)
      .innerJoin(users, eq(users.id, invitations.invitedBy))
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.invitationId, id)))
      .limit(1);
    return row ?? null;
  }

  /** Lookup by token hash, with the organization name for the acceptance page. */
  async findByTokenHash(tokenHash: string, ex: Executor = this.db) {
    const [row] = await ex
      .select({ invitation: invitations, organizationName: tenants.name, organizationLogo: tenants.logo })
      .from(invitations)
      .innerJoin(tenants, eq(tenants.id, invitations.tenantId))
      .where(eq(invitations.tokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  }

  async findByTokenHashForUpdate(tokenHash: string, ex: Executor): Promise<Invitation | null> {
    const [row] = await ex.select().from(invitations).where(eq(invitations.tokenHash, tokenHash)).limit(1).for('update');
    return row ?? null;
  }

  /** Revokes the pending invitation for this e-mail, if any (re-inviting replaces it). */
  async revokePending(tenantId: string, email: string, ex: Executor = this.db): Promise<void> {
    await ex
      .update(invitations)
      .set({ status: 'REVOKED' })
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.email, email), eq(invitations.status, 'PENDING')));
  }

  async setStatus(
    tenantId: string,
    id: number,
    changes: Pick<Invitation, 'status'> & Partial<Pick<Invitation, 'acceptedBy' | 'acceptedAt'>>,
    ex: Executor = this.db,
  ): Promise<void> {
    await ex.update(invitations).set(changes).where(and(eq(invitations.tenantId, tenantId), eq(invitations.invitationId, id)));
  }

  async list(tenantId: string, opts: { limit: number; offset: number }, ex: Executor = this.db) {
    const where = eq(invitations.tenantId, tenantId);
    const items: InvitationView[] = await ex
      .select(view)
      .from(invitations)
      .innerJoin(users, eq(users.id, invitations.invitedBy))
      .where(where)
      .orderBy(desc(invitations.createdAt), desc(invitations.invitationId))
      .limit(opts.limit)
      .offset(opts.offset);
    const [{ total } = { total: 0 }] = await ex.select({ total: count() }).from(invitations).where(where);
    return { items, total };
  }
}
