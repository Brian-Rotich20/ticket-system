import { eq } from 'drizzle-orm';
import type { Database, Executor } from '../config/db.js';
import { tenants, type Tenant } from '../model/schema.js';

/** Tenants are organizations; `id` is the organization slug. */
export class TenantRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string, ex: Executor = this.db): Promise<Tenant | null> {
    const [row] = await ex.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return row ?? null;
  }

  /** Inserts unless the id is taken. Returns null on a taken id. */
  async insertIfFree(values: { id: string; name: string }, ex: Executor = this.db): Promise<Tenant | null> {
    const [row] = await ex.insert(tenants).values(values).onConflictDoNothing({ target: tenants.id }).returning();
    return row ?? null;
  }

  async update(id: string, changes: Partial<Pick<Tenant, 'name' | 'logo'>>, ex: Executor = this.db): Promise<Tenant | null> {
    const [row] = await ex.update(tenants).set(changes).where(eq(tenants.id, id)).returning();
    return row ?? null;
  }
}
