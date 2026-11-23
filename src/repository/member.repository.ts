import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { Database, Executor } from '../config/db.js';
import type { MemberRole, MemberStatus } from '../model/enums.js';
import { organizationMembers, tenants, users, type OrganizationMember } from '../model/schema.js';

/** A member of an organization with the account details a team screen needs. */
export interface MemberView {
  userId: string;
  tenantId: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: MemberRole;
  status: MemberStatus;
  createdAt: Date;
  updatedAt: Date;
}

const memberView = {
  userId: organizationMembers.userId,
  tenantId: organizationMembers.tenantId,
  name: users.name,
  email: users.email,
  emailVerified: users.emailVerified,
  role: organizationMembers.role,
  status: organizationMembers.status,
  createdAt: organizationMembers.createdAt,
  updatedAt: organizationMembers.updatedAt,
};

/** Every method is scoped to one organization, except listOrganizationsForUser (scoped to the caller). */
export class MemberRepository {
  constructor(private readonly db: Database) {}

  async find(tenantId: string, userId: string, ex: Executor = this.db): Promise<OrganizationMember | null> {
    const [row] = await ex
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.tenantId, tenantId), eq(organizationMembers.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  /** SELECT ... FOR UPDATE on the membership row (use inside a transaction). */
  async findForUpdate(tenantId: string, userId: string, ex: Executor): Promise<OrganizationMember | null> {
    const [row] = await ex
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.tenantId, tenantId), eq(organizationMembers.userId, userId)))
      .limit(1)
      .for('update');
    return row ?? null;
  }

  async findView(tenantId: string, userId: string, ex: Executor = this.db): Promise<MemberView | null> {
    const [row] = await ex
      .select(memberView)
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.tenantId, tenantId), eq(organizationMembers.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  /** Active member by e-mail (case-insensitive). */
  async findByEmail(tenantId: string, email: string, ex: Executor = this.db): Promise<MemberView | null> {
    const [row] = await ex
      .select(memberView)
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.tenantId, tenantId), sql`lower(${users.email}) = ${email.toLowerCase()}`))
      .limit(1);
    return row ?? null;
  }

  /** Insert, or re-activate an existing (deactivated) membership with the given role. */
  async upsert(values: { tenantId: string; userId: string; role: MemberRole }, ex: Executor = this.db): Promise<OrganizationMember> {
    const [row] = await ex
      .insert(organizationMembers)
      .values({ ...values, status: 'ACTIVE' })
      .onConflictDoUpdate({
        target: [organizationMembers.tenantId, organizationMembers.userId],
        set: { role: values.role, status: 'ACTIVE', updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  async update(
    tenantId: string,
    userId: string,
    changes: { role?: MemberRole; status?: MemberStatus },
    ex: Executor = this.db,
  ): Promise<OrganizationMember | null> {
    const [row] = await ex
      .update(organizationMembers)
      .set({ ...changes, updatedAt: new Date() })
      .where(and(eq(organizationMembers.tenantId, tenantId), eq(organizationMembers.userId, userId)))
      .returning();
    return row ?? null;
  }

  /** Active admins, locked: serialises concurrent "remove the last admin" attempts. */
  async lockActiveAdmins(tenantId: string, ex: Executor): Promise<string[]> {
    const rows = await ex
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.tenantId, tenantId), eq(organizationMembers.role, 'ADMIN'), eq(organizationMembers.status, 'ACTIVE')))
      .for('update');
    return rows.map((r) => r.userId);
  }

  async listActiveEmails(tenantId: string, role?: MemberRole, ex: Executor = this.db): Promise<{ userId: string; email: string }[]> {
    return ex
      .select({ userId: users.id, email: users.email })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.tenantId, tenantId),
          eq(organizationMembers.status, 'ACTIVE'),
          role ? eq(organizationMembers.role, role) : undefined,
        ),
      );
  }

  async list(
    tenantId: string,
    opts: { role?: MemberRole; status?: MemberStatus; limit: number; offset: number },
    ex: Executor = this.db,
  ): Promise<{ items: MemberView[]; total: number }> {
    const where = and(
      eq(organizationMembers.tenantId, tenantId),
      opts.role ? eq(organizationMembers.role, opts.role) : undefined,
      opts.status ? eq(organizationMembers.status, opts.status) : undefined,
    );
    const items = await ex
      .select(memberView)
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(where)
      .orderBy(asc(organizationMembers.createdAt), asc(organizationMembers.userId))
      .limit(opts.limit)
      .offset(opts.offset);
    const [{ total } = { total: 0 }] = await ex.select({ total: count() }).from(organizationMembers).where(where);
    return { items, total };
  }

  /** The organizations the user can act in (ACTIVE memberships only). */
  async listOrganizationsForUser(userId: string, ex: Executor = this.db) {
    return ex
      .select({ id: tenants.id, name: tenants.name, logo: tenants.logo, role: organizationMembers.role, joinedAt: organizationMembers.createdAt })
      .from(organizationMembers)
      .innerJoin(tenants, eq(tenants.id, organizationMembers.tenantId))
      .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'ACTIVE')))
      .orderBy(asc(tenants.name));
  }
}
