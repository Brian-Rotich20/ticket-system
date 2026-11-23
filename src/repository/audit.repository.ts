import { and, count, desc, eq, getTableColumns } from "drizzle-orm";
import type { Database, Executor } from "../config/db.js";
import type { MemberRole } from "../model/enums.js";
import { auditLogs, organizationMembers, users, type AuditLog } from "../model/schema.js";

export interface AuditEntry {
  tenantId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | number;
  metadata?: Record<string, unknown>;
}

/** An audit row plus who did it, so the admin screen can show names. */
export type AuditView = AuditLog & { actorName: string | null; actorRole: MemberRole | null };

export class AuditRepository {
  constructor(private readonly db: Database) {}

  async insert(entry: AuditEntry, ex: Executor = this.db): Promise<void> {
    await ex.insert(auditLogs).values({ ...entry, entityId: String(entry.entityId), metadata: entry.metadata ?? null });
  }

  async list(
    tenantId: string,
    filter: { entityType?: string; entityId?: string; actorId?: string; action?: string },
    opts: { limit: number; offset: number },
    ex: Executor = this.db,
  ): Promise<{ items: AuditView[]; total: number }> {
    const where = and(
      eq(auditLogs.tenantId, tenantId),
      filter.entityType ? eq(auditLogs.entityType, filter.entityType) : undefined,
      filter.entityId ? eq(auditLogs.entityId, filter.entityId) : undefined,
      filter.actorId ? eq(auditLogs.actorId, filter.actorId) : undefined,
      filter.action ? eq(auditLogs.action, filter.action) : undefined,
    );
    // actorRole: the actor's role in THIS organization (null for customers and system actions)
    const items: AuditView[] = await ex
      .select({ ...getTableColumns(auditLogs), actorName: users.name, actorRole: organizationMembers.role })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .leftJoin(organizationMembers, and(eq(organizationMembers.tenantId, auditLogs.tenantId), eq(organizationMembers.userId, auditLogs.actorId)))
      .where(where)
      .orderBy(desc(auditLogs.auditId))
      .limit(opts.limit)
      .offset(opts.offset);
    const [{ total } = { total: 0 }] = await ex.select({ total: count() }).from(auditLogs).where(where);
    return { items, total };
  }
}