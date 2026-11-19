import { and, asc, count, desc, eq, getTableColumns, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database, Executor } from '../config/db.js';
import type { Priority, TicketStatus, TicketType } from '../model/enums.js';
import { tickets, users, type NewTicket, type Ticket } from '../model/schema.js';

export interface TicketFilter {
  status?: TicketStatus;
  priority?: Priority;
  type?: TicketType;
  assigneeId?: string;
  /** Only tickets nobody has picked up. Takes precedence over assigneeId. */
  unassigned?: boolean;
  requesterId?: string;
  q?: string;
}
export interface TicketListOptions {
  limit: number;
  offset: number;
  sortBy: 'createdAt' | 'updatedAt' | 'priority';
  order: 'asc' | 'desc';
}
export type TicketChanges = Partial<Pick<Ticket, 'status' | 'priority' | 'type' | 'assigneeId'>>;

/** A ticket plus the names a list screen needs (users can't be looked up one by one from the browser). */
export type TicketView = Ticket & { requesterName: string; assigneeName: string | null };

const requester = alias(users, 'requester');
const assignee = alias(users, 'assignee');
const viewColumns = { ...getTableColumns(tickets), requesterName: requester.name, assigneeName: assignee.name };

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');
const inTenant = (tenantId: string, id: number) => and(eq(tickets.tenantId, tenantId), eq(tickets.ticketId, id));

/** Every query is scoped by tenantId: a ticket of another tenant simply does not exist for the caller. */
export class TicketRepository {
  constructor(private readonly db: Database) {}

  async insert(values: NewTicket, ex: Executor = this.db): Promise<Ticket> {
    const [row] = await ex.insert(tickets).values(values).returning();
    return row!;
  }

  async findById(tenantId: string, id: number, ex: Executor = this.db): Promise<Ticket | null> {
    const [row] = await ex.select().from(tickets).where(inTenant(tenantId, id)).limit(1);
    return row ?? null;
  }

    /** Ticket plus requester/assignee names, for detail screens. */
  async findViewById(tenantId: string, id: number, ex: Executor = this.db): Promise<TicketView | null> {
    const [row] = await ex
      .select(viewColumns)
      .from(tickets)
      .innerJoin(requester, eq(requester.id, tickets.requesterId))
      .leftJoin(assignee, eq(assignee.id, tickets.assigneeId))
      .where(inTenant(tenantId, id))
      .limit(1);
    return row ?? null;
  }

  /** SELECT ... FOR UPDATE: serialises concurrent updates on the same ticket. Use inside a transaction. */
  async findByIdForUpdate(tenantId: string, id: number, ex: Executor): Promise<Ticket | null> {
    const [row] = await ex.select().from(tickets).where(inTenant(tenantId, id)).limit(1).for('update');
    return row ?? null;
  }

  /** Compare-and-set on `version`. Returns null if the row changed underneath us. */
  async update(tenantId: string, id: number, expectedVersion: number, changes: TicketChanges, ex: Executor = this.db): Promise<Ticket | null> {
    const [row] = await ex
      .update(tickets)
      .set({ ...changes, version: sql`${tickets.version} + 1`, updatedAt: new Date() })
      .where(and(inTenant(tenantId, id), eq(tickets.version, expectedVersion)))
      .returning();
    return row ?? null;
  }

  async list(tenantId: string, filter: TicketFilter, opts: TicketListOptions, ex: Executor = this.db) {
    const conds: (SQL | undefined)[] = [
      eq(tickets.tenantId, tenantId),
      filter.status && eq(tickets.status, filter.status),
      filter.priority && eq(tickets.priority, filter.priority),
      filter.type && eq(tickets.type, filter.type),
      filter.unassigned ? isNull(tickets.assigneeId) : filter.assigneeId ? eq(tickets.assigneeId, filter.assigneeId) : undefined,
      filter.requesterId ? eq(tickets.requesterId, filter.requesterId) : undefined,
      filter.q
        ? or(ilike(tickets.title, `%${escapeLike(filter.q)}%`), ilike(tickets.description, `%${escapeLike(filter.q)}%`))
        : undefined,
    ];
    const where = and(...conds);

    // priority is a Postgres enum declared LOW < MEDIUM < HIGH < URGENT, so DESC puts urgent first
    const sortCol = opts.sortBy === 'priority' ? tickets.priority : opts.sortBy === 'updatedAt' ? tickets.updatedAt : tickets.createdAt;
    const dir = opts.order === 'asc' ? asc : desc;

    const items: TicketView[] = await ex
      .select(viewColumns)
      .from(tickets)
      .innerJoin(requester, eq(requester.id, tickets.requesterId))
      .leftJoin(assignee, eq(assignee.id, tickets.assigneeId))
      .where(where)
      .orderBy(dir(sortCol), dir(tickets.ticketId))
      .limit(opts.limit)
      .offset(opts.offset);

    const [{ total } = { total: 0 }] = await ex.select({ total: count() }).from(tickets).where(where);
    return { items, total };
  }
}