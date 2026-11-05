import type { Database } from '../config/db.js';
import { toPage } from '../dto/common.dto.js';
import type { CreateTicketInput, TicketFilterQuery, TicketSearchQuery, UpdateTicketInput } from '../dto/ticket.dto.js';
import {
  ConflictError,
  InvalidStatusTransitionError,
  NotFoundError,
  TicketClosedError,
  ValidationError,
} from '../exception/errors.js';
import { canTransition, type TicketStatus } from '../model/enums.js';
import type { Ticket, User } from '../model/schema.js';
import type { TicketChanges, TicketRepository } from '../repository/ticket.repository.js';
import type { UserRepository } from '../repository/user.repository.js';
import type { AuthUser } from '../auth/auth-user.js'
import type { AuditService } from './audit.service.js';
import type { NotificationService } from './notification.service.js';
import { assertCanAssign, assertCanTriage, assertCanChangeStatus, assertCanView } from './policy.js';

type TicketEvent =
  | { type: 'assigned'; ticket: Ticket; assignee: User; previousAssigneeId: number | null }
  | { type: 'status'; ticket: Ticket; oldStatus: TicketStatus; newStatus: TicketStatus };

export class TicketService {
  constructor(
    private readonly db: Database,
    private readonly tickets: TicketRepository,
    private readonly users: UserRepository,
    private readonly audit: AuditService,
    private readonly notifier: NotificationService,
  ) {}

  async createTicket(actor: AuthUser, input: CreateTicketInput): Promise<Ticket> {
    const ticket = await this.db.transaction(async (tx) => {
      const created = await this.tickets.insert({ tenantId: actor.tenantId, title: input.title, description: input.description,
                      type: input.type, priority: input.priority, requesterId: actor.id }, tx);
      await this.audit.record(
        { actorId: actor.id, action: 'TICKET_CREATED', entityType: 'TICKET', entityId: created.ticketId, metadata: { priority: created.priority } },
        tx,
      );
      return created;
    });
    this.notifier.notifyOnTicketCreate(ticket); // after commit
    return ticket;
  }

  async getTicketById(actor: AuthUser, ticketId: number): Promise<Ticket> {
    const ticket = await this.tickets.findById(ticketId);
    if (!ticket) throw new NotFoundError('Ticket', ticketId);
    assertCanView(actor, ticket);
    return ticket;
  }

  updateTicketStatus(actor: AuthUser, ticketId: number, status: TicketStatus, version?: number) {
    return this.mutate(actor, ticketId, { status, version });
  }

  assignTicket(actor: AuthUser, ticketId: number, agentId: number | null, version?: number) {
    return this.mutate(actor, ticketId, { assigneeId: agentId, version });
  }

  /** PATCH /tickets/{id}: status, priority and assignee in ONE atomic, row-locked transaction. */
  updateTicket(actor: AuthUser, ticketId: number, patch: UpdateTicketInput) {
    return this.mutate(actor, ticketId, patch);
  }

  /** GET /tickets: customers are always scoped to their own tickets; staff see everything. */
  async getTickets(actor: AuthUser, q: TicketFilterQuery) {
    const filter = { status: q.status, priority: q.priority, assigneeId: q.assigneeId, requesterId: q.requesterId };
    if (actor.role === 'CUSTOMER') filter.requesterId = actor.id;
    return this.page(filter, q);
  }

  /** GET /tickets/search?q= */
  async searchTickets(actor: AuthUser, q: TicketSearchQuery) {
    const filter = { status: q.status, priority: q.priority, assigneeId: q.assigneeId, requesterId: q.requesterId, q: q.q };
    if (actor.role === 'CUSTOMER') filter.requesterId = actor.id;
    return this.page(filter, q);
  }

  /** GET /tickets/my: tickets assigned to me (staff) / tickets I raised (customer). */
  async getMyTickets(actor: AuthUser, q: TicketFilterQuery) {
    const filter = { status: q.status, priority: q.priority } as { status?: TicketStatus; priority?: Ticket['priority']; assigneeId?: number; requesterId?: number };
    if (actor.role === 'CUSTOMER') filter.requesterId = actor.id;
    else filter.assigneeId = actor.id;
    return this.page(filter, q);
  }

  private async page(filter: Parameters<TicketRepository['list']>[0], q: TicketFilterQuery) {
    const { items, total } = await this.tickets.list(filter, {
      limit: q.pageSize,
      offset: (q.page - 1) * q.pageSize,
      sortBy: q.sortBy,
      order: q.order,
    });
    return toPage(items, total, q);
  }

  private async mutate(actor: AuthUser, ticketId: number, patch: UpdateTicketInput): Promise<Ticket> {
    const { ticket, events } = await this.db.transaction(async (tx) => {
      const current = await this.tickets.findByIdForUpdate(ticketId, tx); // serialises concurrent updates
      if (!current) throw new NotFoundError('Ticket', ticketId);
      assertCanView(actor, current);

      if (patch.version !== undefined && patch.version !== current.version) {
        throw new ConflictError(
          `Ticket was modified by someone else (your version ${patch.version}, current ${current.version}). Reload and retry.`,
          'VERSION_CONFLICT',
        );
      }
      if (current.status === 'CLOSED') {
        if (patch.status !== undefined) throw new InvalidStatusTransitionError(current.status, patch.status); // e.g. CLOSED -> OPEN
        throw new TicketClosedError(ticketId);
      }

      const changes: TicketChanges = {};
      const audits: { action: string; metadata: Record<string, unknown> }[] = [];
      const events: TicketEvent[] = [];
      let assigneeId = current.assigneeId;
      let newAssignee: User | null = null;
      let assignmentChanged = false;

      const applyAssignment = async (newId: number | null) => {
        assertCanAssign(actor, { assigneeId }, newId);
        if (newId === null) {
          if (current.status === 'IN_PROGRESS') throw new ConflictError('An in-progress ticket must stay assigned; reassign it instead');
        } else {
          const agent = await this.users.findById(newId, tx);
          if (!agent || agent.role !== 'AGENT') throw new ValidationError('Assignee must be an existing agent');
          newAssignee = agent;
        }
        audits.push({ action: 'TICKET_ASSIGNED', metadata: { from: assigneeId, to: newId } });
        changes.assigneeId = newId;
        assigneeId = newId;
        assignmentChanged = true;
      };

      // 1) assignment (agent re-assignment while IN_PROGRESS is admin-only, see policy)
      if (patch.assigneeId !== undefined && patch.assigneeId !== current.assigneeId) await applyAssignment(patch.assigneeId);

      // 2) status, with explicit transition validation
      if (patch.status !== undefined && patch.status !== current.status) {
        const to = patch.status;
        if (!canTransition(current.status, to)) throw new InvalidStatusTransitionError(current.status, to);
        // customers get a clean 403 before any assignment logic runs
        if (actor.role === 'CUSTOMER') assertCanChangeStatus(actor, { requesterId: current.requesterId, assigneeId }, current.status, to);
        if (to === 'IN_PROGRESS' && assigneeId === null) {
          if (actor.role === 'AGENT') await applyAssignment(actor.userId); // picking up a ticket self-assigns it
          else throw new ValidationError('Assign an agent before moving the ticket to IN_PROGRESS');
        }
        assertCanChangeStatus(actor, { requesterId: current.requesterId, assigneeId }, current.status, to);
        changes.status = to;
        audits.push({ action: 'TICKET_STATUS_CHANGED', metadata: { from: current.status, to } });
      }

      // 3) priority
      if (patch.priority !== undefined && patch.priority !== current.priority) {
        assertCanTriage (actor, { assigneeId });
        changes.priority = patch.priority;
        audits.push({ action: 'TICKET_PRIORITY_CHANGED', metadata: { from: current.priority, to: patch.priority } });
      }

      if (Object.keys(changes).length === 0) return { ticket: current, events };

      const updated = await this.tickets.update(ticketId, current.version, changes, tx);
      if (!updated) throw new ConflictError('Ticket was modified concurrently. Reload and retry.', 'VERSION_CONFLICT');
      for (const a of audits) {
        await this.audit.record({ actorId: actor.id, action: a.action, entityType: 'TICKET', entityId: ticketId, metadata: a.metadata }, tx);
      }
      if (assignmentChanged && newAssignee) {
        events.push({ type: 'assigned', ticket: updated, assignee: newAssignee, previousAssigneeId: current.assigneeId });
      }
      if (changes.status) events.push({ type: 'status', ticket: updated, oldStatus: current.status, newStatus: changes.status });
      return { ticket: updated, events };
    });

    for (const e of events) {
      if (e.type === 'assigned') this.notifier.notifyOnAssignment(e.ticket, e.assignee, e.previousAssigneeId);
      else this.notifier.notifyOnStatusChange(e.ticket, e.oldStatus, e.newStatus);
    }
    return ticket;
  }
}
