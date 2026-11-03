import { asc, count, eq } from 'drizzle-orm';
import type { Database, Executor } from '../config/db.js';
import { comments, type Comment } from '../model/schema.js';

export class CommentRepository {
  constructor(private readonly db: Database) {}

  async insert(values: { ticketId: number; authorId: number; text: string }, ex: Executor = this.db): Promise<Comment> {
    const [row] = await ex.insert(comments).values(values).returning();
    return row!;
  }

  async findById(id: number, ex: Executor = this.db): Promise<Comment | null> {
    const [row] = await ex.select().from(comments).where(eq(comments.commentId, id)).limit(1);
    return row ?? null;
  }

  async listByTicket(ticketId: number, opts: { limit: number; offset: number }, ex: Executor = this.db) {
    const items = await ex
      .select()
      .from(comments)
      .where(eq(comments.ticketId, ticketId))
      .orderBy(asc(comments.createdAt), asc(comments.commentId))
      .limit(opts.limit)
      .offset(opts.offset);
    const [{ total } = { total: 0 }] = await ex.select({ total: count() }).from(comments).where(eq(comments.ticketId, ticketId));
    return { items, total };
  }

  async delete(id: number, ex: Executor = this.db): Promise<void> {
    await ex.delete(comments).where(eq(comments.commentId, id));
  }
}
