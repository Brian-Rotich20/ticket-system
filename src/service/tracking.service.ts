import type { AuthUser } from '../auth/auth-user.js';
import type { Database } from '../config/db.js';
import { AppError, NotFoundError } from '../exception/errors.js';
import type { TrackingToken } from '../model/schema.js';
import type { CommentRepository, CommentView } from '../repository/comment.repository.js';
import type { TenantRepository } from '../repository/tenant.repository.js';
import type { TicketRepository } from '../repository/ticket.repository.js';
import type { TrackingTokenRepository } from '../repository/tracking.repository.js';
import type { AttachmentService } from './attachment.service.js';
import type { AuditService } from './audit.service.js';
import type { CommentService } from './comment.service.js';
import { assertCanView } from './policy.js';
import { addDays, generateToken, hashToken, isWellFormedToken } from './secure-token.js';

/** Same answer for malformed, unknown, expired and revoked tokens, so tokens can't be probed. */
export class TrackingLinkInvalidError extends AppError {
  constructor() {
    super(404, 'TRACKING_LINK_INVALID', 'This tracking link is invalid or has expired. Ask the business for a new one.');
  }
}

/** A comment as the customer sees it: no internal notes, no staff ids or e-mails. */
export interface PublicComment {
  commentId: number;
  text: string;
  authorType: 'STAFF' | 'CONTACT';
  authorName: string;
  createdAt: Date;
}

const toPublicComment = (c: CommentView): PublicComment => ({
  commentId: c.commentId,
  text: c.text,
  authorType: c.authorType,
  authorName: c.authorName,
  createdAt: c.createdAt,
});

/**
 * Customer tracking links. The raw token is returned once, to the staff member who created it; only its SHA-256
 * is stored. A token grants read access to that one ticket's public information and lets the customer reply.
 */
export class TrackingService {
  constructor(
    private readonly db: Database,
    private readonly tokens: TrackingTokenRepository,
    private readonly tickets: TicketRepository,
    private readonly tenants: TenantRepository,
    private readonly comments: CommentRepository,
    private readonly commentService: CommentService,
    private readonly attachments: AttachmentService,
    private readonly audit: AuditService,
    private readonly opts: { ttlDays: number; appUrl?: string },
  ) {}

  /** Creates the ticket's tracking link, revoking the previous one: a ticket has at most one active link. */
  async createLink(actor: AuthUser, ticketId: number) {
    const { token, expiresAt } = await this.db.transaction(async (tx) => {
      const ticket = await this.tickets.findByIdForUpdate(actor.tenantId, ticketId, tx); // serialises concurrent link creation
      if (!ticket) throw new NotFoundError('Ticket', ticketId);
      assertCanView(actor, ticket);
      const replaced = await this.tokens.revokeActive(actor.tenantId, ticketId, tx);
      const { token, hash } = generateToken();
      const expiresAt = addDays(new Date(), this.opts.ttlDays);
      await this.tokens.insert({ tenantId: actor.tenantId, ticketId, tokenHash: hash, expiresAt, createdBy: actor.id }, tx);
      await this.audit.record(
        { tenantId: actor.tenantId, actorId: actor.id, action: 'TRACKING_LINK_CREATED', entityType: 'TICKET', entityId: ticketId, metadata: { expiresAt, replaced } },
        tx,
      );
      return { token, expiresAt };
    });
    const path = `/track/${token}`;
    return { token, path, url: this.opts.appUrl ? `${this.opts.appUrl.replace(/\/+$/, '')}${path}` : null, expiresAt };
  }

  /** Whether the ticket has a usable link (the token itself can't be shown again). */
  async getLinkStatus(actor: AuthUser, ticketId: number) {
    const ticket = await this.tickets.findById(actor.tenantId, ticketId);
    if (!ticket) throw new NotFoundError('Ticket', ticketId);
    const active = await this.tokens.findActive(actor.tenantId, ticketId);
    const usable = !!active && active.expiresAt > new Date();
    return { active: usable, expiresAt: usable ? active!.expiresAt : null, createdAt: usable ? active!.createdAt : null };
  }

  async revokeLink(actor: AuthUser, ticketId: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const ticket = await this.tickets.findByIdForUpdate(actor.tenantId, ticketId, tx);
      if (!ticket) throw new NotFoundError('Ticket', ticketId);
      assertCanView(actor, ticket);
      if (await this.tokens.revokeActive(actor.tenantId, ticketId, tx)) {
        await this.audit.record(
          { tenantId: actor.tenantId, actorId: actor.id, action: 'TRACKING_LINK_REVOKED', entityType: 'TICKET', entityId: ticketId },
          tx,
        );
      }
    });
  }

  /** GET /public/tickets/:token: the ticket's public information only. */
  async getPublicTicket(rawToken: string) {
    const link = await this.resolve(rawToken);
    const ticket = await this.tickets.findViewById(link.tenantId, link.ticketId);
    const organization = await this.tenants.findById(link.tenantId);
    if (!ticket || !organization) throw new TrackingLinkInvalidError();
    const { items } = await this.comments.listByTicket(ticket.ticketId, { limit: 500, offset: 0, visibility: 'PUBLIC' });
    return {
      ticket: {
        ticketNumber: ticket.ticketNumber,
        title: ticket.title,
        description: ticket.description,
        status: ticket.status,
        type: ticket.type,
        orderRef: ticket.orderRef,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        resolvedAt: ticket.resolvedAt,
        closedAt: ticket.closedAt,
      },
      organization: { name: organization.name, logo: organization.logo },
      contact: { name: ticket.contactName },
      comments: items.map(toPublicComment),
      attachments: await this.attachments.listPublic(ticket.ticketId),
      canReply: ticket.status !== 'CLOSED',
      linkExpiresAt: link.expiresAt,
    };
  }

  /** POST /public/tickets/:token/comments: the customer's follow-up reply. */
  async addPublicComment(rawToken: string, text: string): Promise<PublicComment> {
    const link = await this.resolve(rawToken);
    return toPublicComment(await this.commentService.addCustomerReply(link.tenantId, link.ticketId, text));
  }

  async readPublicAttachment(rawToken: string, attachmentId: number) {
    const link = await this.resolve(rawToken);
    return this.attachments.readPublicFile(link.ticketId, attachmentId);
  }

  private async resolve(rawToken: string): Promise<TrackingToken> {
    if (!isWellFormedToken(rawToken)) throw new TrackingLinkInvalidError();
    const link = await this.tokens.findByHash(hashToken(rawToken));
    if (!link || link.revokedAt !== null || link.expiresAt <= new Date()) throw new TrackingLinkInvalidError();
    return link;
  }
}
