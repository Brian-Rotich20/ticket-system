import { and, count, desc, eq } from 'drizzle-orm';
import type { Database, Executor } from '../config/db.js';
import { auditLogs, type AuditLog } from '../model/schema.js';

export interface AuditEntry {
  tenantId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | number;
  metadata?: Record<string, unknown>;
}

export class AuditRepository {
  constructor(private readonly db: Database) {}

  async insert(entry: AuditEntry, ex: Executor = this.db): Promise<void> {
    await ex.insert(auditLogs).values({ ...entry, entityId: String(entry.entityId), metadata: entry.metadata ?? null });
  }

  async list(
    filter: { entityType?: string; entityId?: string | number },
    opts: { limit: number; offset: number },
    ex: Executor = this.db,
  ): Promise<{ items: AuditLog[]; total: number }> {
    const where = and(
      filter.entityType ? eq(auditLogs.entityType, filter.entityType) : undefined,
      filter.entityId !== undefined ? eq(auditLogs.entityId, filter.entityId) : undefined,
    );
    const items = await ex.select().from(auditLogs).where(where).orderBy(desc(auditLogs.auditId)).limit(opts.limit).offset(opts.offset);
    const [{ total } = { total: 0 }] = await ex.select({ total: count() }).from(auditLogs).where(where);
    return { items, total };
  }
}
