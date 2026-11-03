import type { Database } from '../config/db.js';
import { toPage, type PaginationQuery } from '../dto/common.dto.js';
import type { CreateCommentInput } from '../dto/comment.dto.js';
import { ForbiddenError, NotFoundError, TicketClosedError } from '../exception/errors.js';
import type { Comment } from '../model/schema.js';
import type { CommentRepository } from '../repository/comment.repository.js';
import type { TicketRepository } from '../repository/ticket.repository.js';
import type { Actor } from './actor.js';
import type { AuditService } from './audit.service.js';
import type { NotificationService } from './notification.service.js';
import { assertCanView, isAdmin } from './policy.js';

export class CommentService {
  constructor(
    private readonly db: Database,
    private readonly comments: CommentRepository,
    private readonly tickets: TicketRepository,
    private readonly audit: AuditService,
    private readonly notifier: NotificationService,
  ) {}

  async addComment(actor: Actor, ticketId: number, input: CreateCommentInput): Promise<Comment> {
    const { comment, ticket } = await this.db.transaction(async (tx) => {
      const ticket = await this.tickets.findByIdForUpdate(ticketId, tx); // no comment lands on a ticket that is being closed
      if (!ticket) throw new NotFoundError('Ticket', ticketId);
      assertCanView(actor, ticket);
      if (ticket.status === 'CLOSED') throw new TicketClosedError(ticketId);
      const comment = await this.comments.insert({ ticketId, authorId: actor.userId, text: input.text }, tx);
      await this.audit.record({ actorId: actor.userId, action: 'COMMENT_ADDED', entityType: 'TICKET', entityId: ticketId, metadata: { commentId: comment.commentId } }, tx);
      return { comment, ticket };
    });
    this.notifier.notifyOnComment(ticket, comment);
    return comment;
  }

  async getCommentsByTicketId(actor: Actor, ticketId: number, p: PaginationQuery) {
    const ticket = await this.tickets.findById(ticketId);
    if (!ticket) throw new NotFoundError('Ticket', ticketId);
    assertCanView(actor, ticket);
    const { items, total } = await this.comments.listByTicket(ticketId, { limit: p.pageSize, offset: (p.page - 1) * p.pageSize });
    return toPage(items, total, p);
  }

  /** Author or admin only. */
  async deleteComment(actor: Actor, commentId: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const comment = await this.comments.findById(commentId, tx);
      if (!comment) throw new NotFoundError('Comment', commentId);
      const ticket = await this.tickets.findById(comment.ticketId, tx);
      if (!ticket) throw new NotFoundError('Ticket', comment.ticketId);
      assertCanView(actor, ticket);
      if (comment.authorId !== actor.userId && !isAdmin(actor)) throw new ForbiddenError('Only the author or an admin can delete a comment');
      await this.comments.delete(commentId, tx);
      await this.audit.record({ actorId: actor.userId, action: 'COMMENT_DELETED', entityType: 'TICKET', entityId: ticket.ticketId, metadata: { commentId } }, tx);
    });
  }
}
