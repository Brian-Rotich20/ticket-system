import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { Database, Executor } from '../config/db.js';
import type { Priority, TicketStatus } from '../model/enums.js';
import { tickets, type NewTicket, type Ticket } from '../model/schema.js';

export interface TicketFilter {
  status?: TicketStatus;
  priority?: Priority;
  assigneeId?: number;
  requesterId?: number;
  q?: string;
}
export interface TicketListOptions {
  limit: number;
  offset: number;
  sortBy: 'createdAt' | 'updatedAt';
  order: 'asc' | 'desc';
}
export type TicketChanges = Partial<Pick<Ticket, 'status' | 'priority' | 'assigneeId'>>;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

export class TicketRepository {
  constructor(private readonly db: Database) {}

  async insert(values: NewTicket, ex: Executor = this.db): Promise<Ticket> {
    const [row] = await ex.insert(tickets).values(values).returning();
    return row!;
  }

  async findById(id: number, ex: Executor = this.db): Promise<Ticket | null> {
    const [row] = await ex.select().from(tickets).where(eq(tickets.ticketId, id)).limit(1);
    return row ?? null;
  }

  /** Row lock (SELECT ... FOR UPDATE): serialises concurrent updates on the same ticket. Use inside a transaction. */
  async findByIdForUpdate(id: number, ex: Executor): Promise<Ticket | null> {
    const [row] = await ex.select().from(tickets).where(eq(tickets.ticketId, id)).limit(1).for('update');
    return row ?? null;
  }

  /** Compare-and-set on `version`. Returns null if the row changed underneath us. */
  async update(id: number, expectedVersion: number, changes: TicketChanges, ex: Executor = this.db): Promise<Ticket | null> {
    const [row] = await ex
      .update(tickets)
      .set({ ...changes, version: sql`${tickets.version} + 1`, updatedAt: new Date() })
      .where(and(eq(tickets.ticketId, id), eq(tickets.version, expectedVersion)))
      .returning();
    return row ?? null;
  }

  async list(filter: TicketFilter, opts: TicketListOptions, ex: Executor = this.db) {
    const conds: (SQL | undefined)[] = [
      filter.status && eq(tickets.status, filter.status),
      filter.priority && eq(tickets.priority, filter.priority),
      filter.assigneeId !== undefined ? eq(tickets.assigneeId, filter.assigneeId) : undefined,
      filter.requesterId !== undefined ? eq(tickets.requesterId, filter.requesterId) : undefined,
      filter.q
        ? or(ilike(tickets.title, `%${escapeLike(filter.q)}%`), ilike(tickets.description, `%${escapeLike(filter.q)}%`))
        : undefined,
    ];
    const where = and(...conds);
    const sortCol = opts.sortBy === 'updatedAt' ? tickets.updatedAt : tickets.createdAt;
    const dir = opts.order === 'asc' ? asc : desc;

    const items = await ex
      .select()
      .from(tickets)
      .where(where)
      .orderBy(dir(sortCol), dir(tickets.ticketId))
      .limit(opts.limit)
      .offset(opts.offset);
    const [{ total } = { total: 0 }] = await ex.select({ total: count() }).from(tickets).where(where);
    return { items, total };
  }
}
