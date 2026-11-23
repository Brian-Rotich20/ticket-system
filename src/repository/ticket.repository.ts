import { and, asc, count, desc, eq, getTableColumns, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database, Executor } from '../config/db.js';
import type { Priority, TicketChannel, TicketStatus, TicketType } from '../model/enums.js';
import { contacts, tenants, tickets, users, type NewTicket, type Ticket } from '../model/schema.js';
import { escapeLike } from './sql-helpers.js';

export interface TicketFilter {
  status?: TicketStatus;
  priority?: Priority;
  type?: TicketType;
  channel?: TicketChannel;
  assigneeId?: string;
  /** Only tickets nobody has picked up. Takes precedence over assigneeId. */
  unassigned?: boolean;
  contactId?: number;
  /** Legacy: first-version tickets raised by a customer account. */
  requesterId?: string;
  q?: string;
}
export interface TicketListOptions {
  limit: number;
  offset: number;
  sortBy: 'createdAt' | 'updatedAt' | 'priority';
  order: 'asc' | 'desc';
}
export type TicketChanges = Partial<
  Pick<Ticket, 'status' | 'priority' | 'type' | 'channel' | 'assigneeId' | 'title' | 'description' | 'orderRef' | 'resolvedAt' | 'closedAt'>
>;

/** A ticket plus the names a list or detail screen needs. */
export type TicketView = Ticket & {
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  assigneeName: string | null;
  createdByName: string;
};

const assignee = alias(users, 'assignee');
const creator = alias(users, 'creator');
const viewColumns = {
  ...getTableColumns(tickets),
  contactName: contacts.name,
  contactPhone: contacts.phone,
  contactEmail: contacts.email,
  assigneeName: assignee.name,
  createdByName: creator.name,
};

const inTenant = (tenantId: string, id: number) => and(eq(tickets.tenantId, tenantId), eq(tickets.ticketId, id));

/** Every query is scoped by tenantId: a ticket of another organization simply does not exist for the caller. */
export class TicketRepository {
  constructor(private readonly db: Database) {}

  /**
   * Next ticket number of the organization. The UPDATE locks the organization row until the transaction ends,
   * so concurrent creations are serialised and numbers are never reused (unlike COUNT + 1).
   * Must run inside the transaction that inserts the ticket.
   */
  async nextTicketNumber(tenantId: string, ex: Executor): Promise<number> {
    const [row] = await ex
      .update(tenants)
      .set({ ticketCounter: sql`${tenants.ticketCounter} + 1` })
      .where(eq(tenants.id, tenantId))
      .returning({ n: tenants.ticketCounter });
    if (!row) throw new Error(`Organization ${tenantId} not found`);
    return row.n;
  }

  async insert(values: NewTicket, ex: Executor = this.db): Promise<Ticket> {
    const [row] = await ex.insert(tickets).values(values).returning();
    return row!;
  }

  async findById(tenantId: string, id: number, ex: Executor = this.db): Promise<Ticket | null> {
    const [row] = await ex.select().from(tickets).where(inTenant(tenantId, id)).limit(1);
    return row ?? null;
  }

  /** Ticket plus contact / assignee / creator names, for detail screens. */
  async findViewById(tenantId: string, id: number, ex: Executor = this.db): Promise<TicketView | null> {
    const [row] = await this.viewQuery(ex).where(inTenant(tenantId, id)).limit(1);
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
      filter.channel && eq(tickets.channel, filter.channel),
      filter.unassigned ? isNull(tickets.assigneeId) : filter.assigneeId ? eq(tickets.assigneeId, filter.assigneeId) : undefined,
      filter.contactId ? eq(tickets.contactId, filter.contactId) : undefined,
      filter.requesterId ? eq(tickets.requesterId, filter.requesterId) : undefined,
      filter.q ? this.searchCondition(filter.q) : undefined,
    ];
    const where = and(...conds);

    // priority is a Postgres enum declared LOW < NORMAL < HIGH < URGENT, so DESC puts urgent first
    const sortCol = opts.sortBy === 'priority' ? tickets.priority : opts.sortBy === 'updatedAt' ? tickets.updatedAt : tickets.createdAt;
    const dir = opts.order === 'asc' ? asc : desc;

    const items: TicketView[] = await this.viewQuery(ex)
      .where(where)
      .orderBy(dir(sortCol), dir(tickets.ticketId))
      .limit(opts.limit)
      .offset(opts.offset);

    // the contact join is only needed when searching by contact name / phone
    const [{ total } = { total: 0 }] = await ex
      .select({ total: count() })
      .from(tickets)
      .innerJoin(contacts, and(eq(contacts.tenantId, tickets.tenantId), eq(contacts.contactId, tickets.contactId)))
      .where(where);
    return { items, total };
  }

  /** Ticket counts per status, for the dashboard. */
  async countByStatus(tenantId: string, ex: Executor = this.db): Promise<Record<TicketStatus, number>> {
    const rows = await ex
      .select({ status: tickets.status, total: count() })
      .from(tickets)
      .where(eq(tickets.tenantId, tenantId))
      .groupBy(tickets.status);
    const out = { OPEN: 0, IN_PROGRESS: 0, WAITING_ON_CUSTOMER: 0, RESOLVED: 0, CLOSED: 0 } as Record<TicketStatus, number>;
    for (const r of rows) out[r.status] = r.total;
    return out;
  }

  /** Open work (not RESOLVED / CLOSED) per assignee, unassigned included as null. */
  async countOpenByAssignee(tenantId: string, ex: Executor = this.db) {
    return ex
      .select({ assigneeId: tickets.assigneeId, assigneeName: assignee.name, total: count() })
      .from(tickets)
      .leftJoin(assignee, eq(assignee.id, tickets.assigneeId))
      .where(and(eq(tickets.tenantId, tenantId), sql`${tickets.status} not in ('RESOLVED', 'CLOSED')`))
      .groupBy(tickets.assigneeId, assignee.name)
      .orderBy(desc(count()));
  }

  private viewQuery(ex: Executor) {
    return ex
      .select(viewColumns)
      .from(tickets)
      .innerJoin(contacts, and(eq(contacts.tenantId, tickets.tenantId), eq(contacts.contactId, tickets.contactId)))
      .innerJoin(creator, eq(creator.id, tickets.createdBy))
      .leftJoin(assignee, eq(assignee.id, tickets.assigneeId));
  }

  /** Subject, description, order reference, contact name / phone, or the ticket number ("42" or "#42"). */
  private searchCondition(q: string): SQL | undefined {
    const like = `%${escapeLike(q)}%`;
    const number = /^#?(\d{1,9})$/.exec(q.trim());
    return or(
      ilike(tickets.title, like),
      ilike(tickets.description, like),
      ilike(tickets.orderRef, like),
      ilike(contacts.name, like),
      ilike(contacts.phone, like),
      number ? eq(tickets.ticketNumber, Number(number[1])) : undefined,
    );
  }
}
