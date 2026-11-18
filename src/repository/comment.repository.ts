import { asc, count, eq } from "drizzle-orm";
import type { Database, Executor } from "../config/db.js";
import type { UserRole } from "../model/enums.js";
import { comments, users, type Comment } from "../model/schema.js";

/** A comment plus who wrote it. Customers cannot look up staff, so the name travels with the comment. */
export type CommentView = Comment & { authorName: string; authorRole: UserRole };

const viewColumns = {
  commentId: comments.commentId,
  ticketId: comments.ticketId,
  authorId: comments.authorId,
  text: comments.text,
  createdAt: comments.createdAt,
  authorName: users.name,
  authorRole: users.role,
};

/** Tenant isolation is enforced one level up: callers always load the (tenant-scoped) ticket first. */
export class CommentRepository {
  constructor(private readonly db: Database) {}

  async insert(values: { ticketId: number; authorId: string; text: string }, ex: Executor = this.db): Promise<Comment> {
    const [row] = await ex.insert(comments).values(values).returning();
    return row!;
  }

  async findById(id: number, ex: Executor = this.db): Promise<Comment | null> {
    const [row] = await ex.select().from(comments).where(eq(comments.commentId, id)).limit(1);
    return row ?? null;
  }

  async findViewById(id: number, ex: Executor = this.db): Promise<CommentView | null> {
    const [row] = await ex
      .select(viewColumns)
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.commentId, id))
      .limit(1);
    return row ?? null;
  }

  async listByTicket(ticketId: number, opts: { limit: number; offset: number }, ex: Executor = this.db) {
    const items: CommentView[] = await ex
      .select(viewColumns)
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
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