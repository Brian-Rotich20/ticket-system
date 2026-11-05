import { and, count, eq, inArray } from 'drizzle-orm';
import type { Database, Executor } from '../config/db.js';
import type { UserRole } from '../model/enums.js';
import { users, type User } from '../model/schema.js';

/** Every method takes the tenant id: a user from another tenant can never be read or modified. */
export class UserRepository {
  constructor(private readonly db: Database) {}

  async findById(tenantId: string, id: string, ex: Executor = this.db): Promise<User | null> {
    const [row] = await ex.select().from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, id))).limit(1);
    return row ?? null;
  }

  async findManyByIds(tenantId: string, ids: string[], ex: Executor = this.db): Promise<User[]> {
    if (ids.length === 0) return [];
    return ex.select().from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, ids)));
  }

  async listByRole(tenantId: string, role: UserRole, ex: Executor = this.db): Promise<User[]> {
    return ex.select().from(users).where(and(eq(users.tenantId, tenantId), eq(users.role, role)));
  }

  async setRole(tenantId: string, id: string, role: UserRole, ex: Executor = this.db): Promise<User | null> {
    const [row] = await ex
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(users.tenantId, tenantId), eq(users.id, id)))
      .returning();
    return row ?? null;
  }

  async list(tenantId: string, opts: { role?: UserRole; limit: number; offset: number }, ex: Executor = this.db) {
    const where = and(eq(users.tenantId, tenantId), opts.role ? eq(users.role, opts.role) : undefined);
    const items = await ex.select().from(users).where(where).orderBy(users.createdAt, users.id).limit(opts.limit).offset(opts.offset);
    const [{ total } = { total: 0 }] = await ex.select({ total: count() }).from(users).where(where);
    return { items, total };
  }
}