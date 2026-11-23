import type { AuthUser } from '../auth/auth-user.js';
import type { Database } from '../config/db.js';
import type { CreateCommentInput } from '../dto/comment.dto.js';
import { toPage, type PaginationQuery } from '../dto/common.dto.js';
import { ConflictError, ForbiddenError, NotFoundError, TicketClosedError } from '../exception/errors.js';
import { REOPEN_ON_CUSTOMER_REPLY, type TicketStatus } from '../model/enums.js';
import type { Ticket } from '../model/schema.js';
import type { CommentRepository, CommentView } from '../repository/comment.repository.js';
import type { TicketRepository } from '../repository/ticket.repository.js';
import type { AuditService } from './audit.service.js';
import type { NotificationService } from './notification.service.js';
import { assertCanView, isAdmin } from './policy.js';
import { statusTimestamps } from './ticket.service.js';

export class CommentService {
  constructor(
    private readonly db: Database,
    private readonly comments: CommentRepository,
    private readonly tickets: TicketRepository,
    private readonly audit: AuditService,
    private readonly notifier: NotificationService,
  ) {}

  /** Staff comment: a PUBLIC reply (shown on the tracking page) or an INTERNAL note (staff only). */
  async addComment(actor: AuthUser, ticketId: number, input: CreateCommentInput): Promise<CommentView> {
    const { comment, ticket } = await this.db.transaction(async (tx) => {
      const ticket = await this.tickets.findByIdForUpdate(actor.tenantId, ticketId, tx); // nothing lands on a ticket that is being closed
      if (!ticket) throw new NotFoundError('Ticket', ticketId);
      assertCanView(actor, ticket);
      if (ticket.status === 'CLOSED') throw new TicketClosedError(ticketId);

      const row = await this.comments.insert({ ticketId, authorId: actor.id, text: input.text, visibility: input.visibility }, tx);
      const comment = await this.comments.findViewById(row.commentId, tx);
      if (!comment) throw new NotFoundError('Comment', row.commentId);

      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorId: actor.id,
          action: 'COMMENT_ADDED',
          entityType: 'TICKET',
          entityId: ticketId,
          metadata: { commentId: comment.commentId, visibility: comment.visibility },
        },
        tx,
      );
      return { comment, ticket };
    });
    this.notifier.notifyOnComment(ticket, comment, actor.id);
    return comment;
  }

  /**
   * A customer's follow-up through the tracking link (the caller has validated the token and resolved the ticket).
   * Always PUBLIC, authored by the ticket's contact. A reply to a ticket that was waiting on the customer, or was
   * resolved, puts it back in the queue: IN_PROGRESS when assigned, OPEN otherwise. Closed tickets take no replies.
   */
  async addCustomerReply(tenantId: string, ticketId: number, text: string): Promise<CommentView> {
    const { comment, ticket, statusChange } = await this.db.transaction(async (tx) => {
      const ticket = await this.tickets.findByIdForUpdate(tenantId, ticketId, tx);
      if (!ticket) throw new NotFoundError('Ticket', ticketId);
      if (ticket.status === 'CLOSED') throw new TicketClosedError(ticketId);

      const row = await this.comments.insert({ ticketId, authorContactId: ticket.contactId, text, visibility: 'PUBLIC' }, tx);
      const comment = await this.comments.findViewById(row.commentId, tx);
      if (!comment) throw new NotFoundError('Comment', row.commentId);
      const system = { tenantId, actorId: null, entityType: 'TICKET', entityId: ticketId };
      await this.audit.record(
        { ...system, action: 'COMMENT_ADDED', metadata: { commentId: comment.commentId, visibility: 'PUBLIC', via: 'TRACKING_LINK', contactId: ticket.contactId } },
        tx,
      );

      let current: Ticket = ticket;
      let statusChange: { from: TicketStatus; to: TicketStatus } | null = null;
      if (REOPEN_ON_CUSTOMER_REPLY.includes(ticket.status)) {
        const to: TicketStatus = ticket.assigneeId ? 'IN_PROGRESS' : 'OPEN';
        const updated = await this.tickets.update(tenantId, ticketId, ticket.version, { status: to, ...statusTimestamps(ticket.status, to) }, tx);
        if (!updated) throw new ConflictError('Ticket was modified concurrently. Retry.', 'VERSION_CONFLICT');
        await this.audit.record({ ...system, action: 'TICKET_STATUS_CHANGED', metadata: { from: ticket.status, to, reason: 'CUSTOMER_REPLY' } }, tx);
        current = updated;
        statusChange = { from: ticket.status, to };
      }
      return { comment, ticket: current, statusChange };
    });
    this.notifier.notifyOnComment(ticket, comment, null);
    if (statusChange) this.notifier.notifyOnStatusChange(ticket, statusChange.from, statusChange.to, null);
    return comment;
  }

  async getCommentsByTicketId(actor: AuthUser, ticketId: number, p: PaginationQuery) {
    const ticket = await this.tickets.findById(actor.tenantId, ticketId);
    if (!ticket) throw new NotFoundError('Ticket', ticketId);
    assertCanView(actor, ticket);
    const { items, total } = await this.comments.listByTicket(ticketId, { limit: p.pageSize, offset: (p.page - 1) * p.pageSize });
    return toPage(items, total, p);
  }

  /** Author or admin only. */
  async deleteComment(actor: AuthUser, commentId: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const comment = await this.comments.findById(commentId, tx);
      if (!comment) throw new NotFoundError('Comment', commentId);
      const ticket = await this.tickets.findById(actor.tenantId, comment.ticketId, tx); // another organization's comment => not found
      if (!ticket) throw new NotFoundError('Comment', commentId);
      assertCanView(actor, ticket);
      if (comment.authorId !== actor.id && !isAdmin(actor)) throw new ForbiddenError('Only the author or an admin can delete a comment');
      await this.comments.delete(commentId, tx);
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorId: actor.id,
          action: 'COMMENT_DELETED',
          entityType: 'TICKET',
          entityId: ticket.ticketId,
          metadata: { commentId },
        },
        tx,
      );
    });
  }
}
