import { eq } from 'drizzle-orm';
import type { Database } from '../config/db.js';
import { tenants, type Tenant } from '../model/schema.js';

export class TenantRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<Tenant | null> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return row ?? null;
  }
}