import { and, asc, count, eq, sql } from "drizzle-orm";
import type { Database, Executor } from "../config/db.js";
import type { CommentVisibility } from "../model/enums.js";
import { comments, contacts, organizationMembers, tickets, users, type Comment } from "../model/schema.js";

/**
 * A comment plus who wrote it. `authorType` is STAFF for organization members (and first-version customer accounts)
 * and CONTACT for a customer reply through the tracking link. `authorRole` is the member role in the ticket's
 * organization, CUSTOMER for contacts and first-version customer accounts.
 */
export type CommentView = Comment & {
  authorType: 'STAFF' | 'CONTACT';
  authorName: string;
  authorRole: 'ADMIN' | 'AGENT' | 'CUSTOMER';
};

const viewColumns = {
  commentId: comments.commentId,
  ticketId: comments.ticketId,
  authorId: comments.authorId,
  authorContactId: comments.authorContactId,
  text: comments.text,
  visibility: comments.visibility,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
  authorType: sql<'STAFF' | 'CONTACT'>`case when ${comments.authorContactId} is not null then 'CONTACT' else 'STAFF' end`,
  authorName: sql<string>`coalesce(${users.name}, ${contacts.name}, 'Customer')`,
  authorRole: sql<'ADMIN' | 'AGENT' | 'CUSTOMER'>`coalesce(${organizationMembers.role}::text, 'CUSTOMER')`,
};

/** Tenant isolation is enforced one level up: callers always load the (tenant-scoped) ticket first. */
export class CommentRepository {
  constructor(private readonly db: Database) {}

  async insert(
    values: { ticketId: number; authorId?: string | null; authorContactId?: number | null; text: string; visibility: CommentVisibility },
    ex: Executor = this.db,
  ): Promise<Comment> {
    const [row] = await ex.insert(comments).values(values).returning();
    return row!;
  }

  async findById(id: number, ex: Executor = this.db): Promise<Comment | null> {
    const [row] = await ex.select().from(comments).where(eq(comments.commentId, id)).limit(1);
    return row ?? null;
  }

  async findViewById(id: number, ex: Executor = this.db): Promise<CommentView | null> {
    const [row] = await this.viewQuery(ex).where(eq(comments.commentId, id)).limit(1);
    return row ?? null;
  }

  /** Oldest first. `visibility` limits the result (the public tracking page passes PUBLIC). */
  async listByTicket(ticketId: number, opts: { limit: number; offset: number; visibility?: CommentVisibility }, ex: Executor = this.db) {
    const where = and(eq(comments.ticketId, ticketId), opts.visibility ? eq(comments.visibility, opts.visibility) : undefined);
    const items: CommentView[] = await this.viewQuery(ex)
      .where(where)
      .orderBy(asc(comments.createdAt), asc(comments.commentId))
      .limit(opts.limit)
      .offset(opts.offset);
    const [{ total } = { total: 0 }] = await ex.select({ total: count() }).from(comments).where(where);
    return { items, total };
  }

  async delete(id: number, ex: Executor = this.db): Promise<void> {
    await ex.delete(comments).where(eq(comments.commentId, id));
  }

  private viewQuery(ex: Executor) {
    return ex
      .select(viewColumns)
      .from(comments)
      .innerJoin(tickets, eq(tickets.ticketId, comments.ticketId))
      .leftJoin(users, eq(users.id, comments.authorId))
      .leftJoin(contacts, eq(contacts.contactId, comments.authorContactId))
      .leftJoin(
        organizationMembers,
        and(eq(organizationMembers.tenantId, tickets.tenantId), eq(organizationMembers.userId, comments.authorId)),
      );
  }
}
