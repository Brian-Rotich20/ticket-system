import type { TicketStatus } from '../model/enums.js';
import type { Comment, Ticket } from '../model/schema.js';
import type { MemberRepository, MemberView } from '../repository/member.repository.js';
import type { EmailSender } from './email.service.js';

interface Logger {
  error(obj: unknown, msg?: string): void;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').slice(0, 120);
const label = (t: Ticket) => `[Ticket #${t.ticketNumber}]`;

/**
 * Notifies staff on important updates (new ticket, assignment, status change, new comment) and invitees.
 * Fire-and-forget: a failing mail provider must never fail or slow down an API request.
 * Recipients are always active members of the ticket's own organization, never the person who acted.
 * Customers (contacts) are not e-mailed: staff keep talking to them on the channel the ticket came from.
 */
export class NotificationService {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly members: MemberRepository,
    private readonly email: EmailSender,
    private readonly log: Logger,
  ) {}

  /** Resolves when all in-flight notifications are done (tests, graceful shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  notifyOnTicketCreate(ticket: Ticket, actorId: string): void {
    this.fire(async () => {
      const agents = (await this.members.listActiveEmails(ticket.tenantId, 'AGENT')).filter((a) => a.userId !== actorId);
      await this.send(
        agents.map((a) => a.email),
        `${label(ticket)} New ${ticket.priority} ${ticket.type}: ${oneLine(ticket.title)}`,
        `A new ticket was recorded (channel: ${ticket.channel}).\n\n${ticket.title}\n\n${ticket.description}`,
      );
    });
  }

  notifyOnAssignment(ticket: Ticket, assignee: MemberView, previousAssigneeId: string | null, actorId: string): void {
    this.fire(async () => {
      const subject = `${label(ticket)} Assigned to ${assignee.name}`;
      if (assignee.userId !== actorId) await this.send([assignee.email], subject, `You have been assigned ticket #${ticket.ticketNumber}: ${ticket.title}`);
      if (previousAssigneeId && previousAssigneeId !== actorId) {
        const previous = await this.activeMember(ticket.tenantId, previousAssigneeId);
        if (previous) await this.send([previous.email], subject, `Ticket #${ticket.ticketNumber} was reassigned to ${assignee.name}.`);
      }
    });
  }

  /** `authorId` is null for a customer reply through the tracking link. */
  notifyOnComment(ticket: Ticket, comment: Comment, authorId: string | null): void {
    this.fire(async () => {
      let recipients: string[];
      if (ticket.assigneeId) {
        const assignee = ticket.assigneeId === authorId ? null : await this.activeMember(ticket.tenantId, ticket.assigneeId);
        recipients = assignee ? [assignee.email] : [];
      } else {
        // nobody owns the ticket yet: a customer reply goes to the whole team
        recipients = authorId ? [] : (await this.members.listActiveEmails(ticket.tenantId, 'AGENT')).map((a) => a.email);
      }
      const who = authorId ? 'New comment' : 'Customer replied';
      await this.send(recipients, `${label(ticket)} ${who}`, `${comment.text}\n\n— on ticket: ${ticket.title}`);
    });
  }

  notifyOnStatusChange(ticket: Ticket, oldStatus: TicketStatus, newStatus: TicketStatus, actorId: string | null): void {
    this.fire(async () => {
      if (!ticket.assigneeId || ticket.assigneeId === actorId) return;
      const assignee = await this.activeMember(ticket.tenantId, ticket.assigneeId);
      if (!assignee) return;
      await this.send([assignee.email], `${label(ticket)} Status: ${oldStatus} -> ${newStatus}`, `Ticket "${ticket.title}" moved from ${oldStatus} to ${newStatus}.`);
    });
  }

  /** The link carries a secret: it goes in the body only (LogEmailSender logs recipients and subject, never the body). */
  notifyInvitation(to: string, organizationName: string, inviterName: string, link: string): void {
    this.fire(() =>
      this.send(
        [to],
        `You're invited to join ${oneLine(organizationName)} on Support Tickets`,
        `${inviterName} invited you to help handle customer tickets for ${organizationName}.\n\nAccept the invitation: ${link}\n\nThe link expires; ask ${inviterName} for a new one if it no longer works.`,
      ),
    );
  }

  private async activeMember(tenantId: string, userId: string) {
    const m = await this.members.findView(tenantId, userId);
    return m && m.status === 'ACTIVE' ? m : null;
  }

  private async send(to: string[], subject: string, text: string): Promise<void> {
    if (to.length > 0) await this.email.send({ to, subject, text });
  }

  private fire(job: () => Promise<void>): void {
    const p = job()
      .catch((err) => this.log.error({ err }, 'notification failed'))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
}
