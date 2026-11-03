import type { TicketStatus } from '../model/enums.js';
import type { Comment, Ticket, User } from '../model/schema.js';
import type { UserRepository } from '../repository/user.repository.js';
import type { EmailSender } from './email.service.js';

interface Logger {
  error(obj: unknown, msg?: string): void;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').slice(0, 120);

/**
 * Notifies users/agents on important updates (assignment, status change, new comment).
 * Fire-and-forget: a failing mail provider must never fail or slow down the API request.
 */
export class NotificationService {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly users: UserRepository,
    private readonly email: EmailSender,
    private readonly log: Logger,
  ) {}

  /** Resolves when all in-flight notifications are done (used by tests and graceful shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  notifyOnTicketCreate(ticket: Ticket): void {
    this.fire(async () => {
      const agents = await this.users.listByRole('AGENT');
      await this.send(
        agents.map((a) => a.email),
        `[Ticket #${ticket.ticketId}] New ${ticket.priority} ticket: ${oneLine(ticket.title)}`,
        `A new ticket was created and is waiting for an agent.\n\n${ticket.title}\n\n${ticket.description}`,
      );
    });
  }

  notifyOnAssignment(ticket: Ticket, agent: User, previousAssigneeId: number | null): void {
    this.fire(async () => {
      const [requester, previous] = await this.users.findManyByIds(
        [ticket.requesterId, ...(previousAssigneeId ? [previousAssigneeId] : [])],
      ).then((rows) => [rows.find((r) => r.userId === ticket.requesterId), rows.find((r) => r.userId === previousAssigneeId)]);
      const subject = `[Ticket #${ticket.ticketId}] Assigned to ${agent.name}`;
      await this.send([agent.email], subject, `You have been assigned ticket #${ticket.ticketId}: ${ticket.title}`);
      if (requester) await this.send([requester.email], subject, `Your ticket is now being handled by ${agent.name}.`);
      if (previous) await this.send([previous.email], subject, `Ticket #${ticket.ticketId} was reassigned to ${agent.name}.`);
    });
  }

  notifyOnComment(ticket: Ticket, comment: Comment): void {
    this.fire(async () => {
      const ids = [ticket.requesterId, ...(ticket.assigneeId ? [ticket.assigneeId] : [])].filter((id) => id !== comment.authorId);
      const recipients = await this.users.findManyByIds(ids);
      await this.send(
        recipients.map((r) => r.email),
        `[Ticket #${ticket.ticketId}] New comment`,
        `${comment.text}\n\n— on ticket: ${ticket.title}`,
      );
    });
  }

  notifyOnStatusChange(ticket: Ticket, oldStatus: TicketStatus, newStatus: TicketStatus): void {
    this.fire(async () => {
      const ids = [ticket.requesterId, ...(ticket.assigneeId ? [ticket.assigneeId] : [])];
      const recipients = await this.users.findManyByIds(ids);
      await this.send(
        recipients.map((r) => r.email),
        `[Ticket #${ticket.ticketId}] Status: ${oldStatus} -> ${newStatus}`,
        `Ticket "${ticket.title}" moved from ${oldStatus} to ${newStatus}.`,
      );
    });
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
