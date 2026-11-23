import type { AuthUser } from '../auth/auth-user.js';
import type { Database, Executor } from '../config/db.js';
import { toPage } from '../dto/common.dto.js';
import type { CreateTicketInput, TicketFilterQuery, TicketSearchQuery, UpdateTicketInput } from '../dto/ticket.dto.js';
import { ConflictError, InvalidStatusTransitionError, NotFoundError, TicketClosedError, ValidationError } from '../exception/errors.js';
import { canTransition, type TicketStatus } from '../model/enums.js';
import type { Ticket } from '../model/schema.js';
import type { MemberRepository, MemberView } from '../repository/member.repository.js';
import type { TicketChanges, TicketFilter, TicketRepository, TicketView } from '../repository/ticket.repository.js';
import type { AuditService } from './audit.service.js';
import type { ContactService } from './contact.service.js';
import type { NotificationService } from './notification.service.js';
import { assertCanAssign, assertCanView, assertCanWork } from './policy.js';

type TicketEvent =
  | { type: 'assigned'; ticket: Ticket; assignee: MemberView; previousAssigneeId: string | null }
  | { type: 'status'; ticket: Ticket; oldStatus: TicketStatus; newStatus: TicketStatus };

/** Someone must own a ticket that is being worked on or waiting for the customer. */
const NEEDS_ASSIGNEE: readonly TicketStatus[] = ['IN_PROGRESS', 'WAITING_ON_CUSTOMER'];

/** Status change side effects on the resolution / closure dates. */
export function statusTimestamps(from: TicketStatus, to: TicketStatus, now = new Date()): Pick<TicketChanges, 'resolvedAt' | 'closedAt'> {
  if (to === 'RESOLVED') return { resolvedAt: now };
  if (to === 'CLOSED') return { closedAt: now };
  if (from === 'RESOLVED') return { resolvedAt: null }; // reopened
  return {};
}

export class TicketService {
  constructor(
    private readonly db: Database,
    private readonly tickets: TicketRepository,
    private readonly members: MemberRepository,
    private readonly contacts: ContactService,
    private readonly audit: AuditService,
    private readonly notifier: NotificationService,
  ) {}

  /** Staff record a ticket for an existing or new contact. Number, contact and audit rows commit together. */
  async createTicket(actor: AuthUser, input: CreateTicketInput): Promise<TicketView> {
    const { ticket, assignee } = await this.db.transaction(async (tx) => {
      const contact = await this.contacts.resolveForTicket(actor, input, tx);
      const assignee = input.assigneeId ? await this.activeMember(actor.tenantId, input.assigneeId, tx) : null;
      const ticketNumber = await this.tickets.nextTicketNumber(actor.tenantId, tx);

      const created = await this.tickets.insert(
        {
          tenantId: actor.tenantId,
          ticketNumber,
          contactId: contact.contactId,
          title: input.title,
          description: input.description,
          type: input.type,
          priority: input.priority,
          channel: input.channel,
          orderRef: input.orderRef ?? null,
          assigneeId: assignee?.userId ?? null,
          createdBy: actor.id,
        },
        tx,
      );
      await this.record(actor, created.ticketId, 'TICKET_CREATED', {
        ticketNumber, contactId: contact.contactId, channel: created.channel, type: created.type, priority: created.priority,
      }, tx);
      if (assignee) await this.record(actor, created.ticketId, 'TICKET_ASSIGNED', { from: null, to: assignee.userId }, tx);
      return { ticket: created, assignee };
    });

    this.notifier.notifyOnTicketCreate(ticket, actor.id); // after commit
    if (assignee) this.notifier.notifyOnAssignment(ticket, assignee, null, actor.id);
    return this.view(actor, ticket.ticketId);
  }

  async getTicketById(actor: AuthUser, ticketId: number): Promise<TicketView> {
    const ticket = await this.tickets.findViewById(actor.tenantId, ticketId);
    if (!ticket) throw new NotFoundError('Ticket', ticketId);
    assertCanView(actor, ticket);
    return ticket;
  }

  /** PATCH /tickets/{id}: workflow fields and details in ONE atomic, row-locked transaction. */
  updateTicket(actor: AuthUser, ticketId: number, patch: UpdateTicketInput) {
    return this.mutate(actor, ticketId, patch);
  }

  /** The organization's queue (every member sees it). */
  getTickets(actor: AuthUser, q: TicketFilterQuery) {
    return this.page(actor, this.filterOf(q), q);
  }

  /** GET /tickets/search?q= : subject, description, order reference, contact name / phone, ticket number. */
  searchTickets(actor: AuthUser, q: TicketSearchQuery) {
    return this.page(actor, { ...this.filterOf(q), q: q.q }, q);
  }

  /** GET /tickets/my: tickets assigned to me. */
  getMyTickets(actor: AuthUser, q: TicketFilterQuery) {
    return this.page(actor, { status: q.status, priority: q.priority, type: q.type, channel: q.channel, assigneeId: actor.id }, q);
  }

  private filterOf(q: TicketFilterQuery): TicketFilter {
    return {
      status: q.status, priority: q.priority, type: q.type, channel: q.channel, assigneeId: q.assigneeId,
      unassigned: q.unassigned === 'true', contactId: q.contactId, requesterId: q.requesterId,
    };
  }

  private async page(actor: AuthUser, filter: TicketFilter, q: TicketFilterQuery) {
    const { items, total } = await this.tickets.list(actor.tenantId, filter, {
      limit: q.pageSize,
      offset: (q.page - 1) * q.pageSize,
      sortBy: q.sortBy,
      order: q.order,
    });
    return toPage(items, total, q);
  }

  private async mutate(actor: AuthUser, ticketId: number, patch: UpdateTicketInput): Promise<TicketView> {
    const { events } = await this.db.transaction(async (tx) => {
      const current = await this.tickets.findByIdForUpdate(actor.tenantId, ticketId, tx); // serialises concurrent updates
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
      const targetStatus = patch.status ?? current.status;
      let assigneeId = current.assigneeId;
      let newAssignee: MemberView | null = null;

      // permissions are judged on the ticket as it was before this request
      const applyAssignment = async (newId: string | null) => {
        assertCanAssign(actor, current);
        if (newId === null) {
          if (NEEDS_ASSIGNEE.includes(targetStatus)) {
            throw new ConflictError(`A ticket that is ${targetStatus} must stay assigned; reassign it instead`);
          }
        } else {
          newAssignee = await this.activeMember(actor.tenantId, newId, tx);
        }
        audits.push({ action: 'TICKET_ASSIGNED', metadata: { from: assigneeId, to: newId } });
        changes.assigneeId = newId;
        assigneeId = newId;
      };

      // 1) assignment
      if (patch.assigneeId !== undefined && patch.assigneeId !== current.assigneeId) await applyAssignment(patch.assigneeId);

      // 2) status, with explicit transition validation
      if (patch.status !== undefined && patch.status !== current.status) {
        const to = patch.status;
        if (!canTransition(current.status, to)) throw new InvalidStatusTransitionError(current.status, to);
        assertCanWork(actor, current);
        if (assigneeId === null && NEEDS_ASSIGNEE.includes(to)) {
          if (actor.role === 'AGENT') await applyAssignment(actor.id); // picking up a ticket self-assigns it
          else throw new ValidationError(`Assign someone before moving the ticket to ${to}`);
        }
        Object.assign(changes, { status: to }, statusTimestamps(current.status, to));
        audits.push({ action: 'TICKET_STATUS_CHANGED', metadata: { from: current.status, to } });
      }

      // 3) triage and details: assignee, admin, or anyone while unassigned
      const fieldChange = <K extends 'priority' | 'type' | 'channel' | 'title' | 'description' | 'orderRef'>(key: K) =>
        patch[key] !== undefined && patch[key] !== current[key];
      if (fieldChange('priority')) {
        assertCanWork(actor, current);
        changes.priority = patch.priority!;
        audits.push({ action: 'TICKET_PRIORITY_CHANGED', metadata: { from: current.priority, to: patch.priority } });
      }
      if (fieldChange('type')) {
        assertCanWork(actor, current);
        changes.type = patch.type!;
        audits.push({ action: 'TICKET_TYPE_CHANGED', metadata: { from: current.type, to: patch.type } });
      }
      const details: Record<string, unknown> = {};
      if (fieldChange('channel')) {
        changes.channel = patch.channel!;
        details.channel = { from: current.channel, to: patch.channel };
      }
      if (fieldChange('orderRef')) {
        changes.orderRef = patch.orderRef ?? null;
        details.orderRef = { from: current.orderRef, to: changes.orderRef };
      }
      if (fieldChange('title')) {
        changes.title = patch.title!;
        details.title = { from: current.title, to: patch.title };
      }
      if (fieldChange('description')) {
        changes.description = patch.description!;
        details.description = true; // changed; the text itself stays out of the audit log
      }
      if (Object.keys(details).length > 0) {
        assertCanWork(actor, current);
        audits.push({ action: 'TICKET_UPDATED', metadata: details });
      }

      if (Object.keys(changes).length === 0) return { ticket: current, events };

      const updated = await this.tickets.update(actor.tenantId, ticketId, current.version, changes, tx);
      if (!updated) throw new ConflictError('Ticket was modified concurrently. Reload and retry.', 'VERSION_CONFLICT');
      for (const a of audits) await this.record(actor, ticketId, a.action, a.metadata, tx);

      if (changes.assigneeId !== undefined && newAssignee) {
        events.push({ type: 'assigned', ticket: updated, assignee: newAssignee, previousAssigneeId: current.assigneeId });
      }
      if (changes.status) events.push({ type: 'status', ticket: updated, oldStatus: current.status, newStatus: changes.status });
      return { ticket: updated, events };
    });

    for (const e of events) {
      if (e.type === 'assigned') this.notifier.notifyOnAssignment(e.ticket, e.assignee, e.previousAssigneeId, actor.id);
      else this.notifier.notifyOnStatusChange(e.ticket, e.oldStatus, e.newStatus, actor.id);
    }
    return this.view(actor, ticketId); // the ticket with names
  }

  /** The assignee must be an ACTIVE member (agent or admin) of the same organization. */
  private async activeMember(tenantId: string, userId: string, tx: Executor): Promise<MemberView> {
    const member = await this.members.findView(tenantId, userId, tx);
    if (!member || member.status !== 'ACTIVE') throw new ValidationError('Assignee must be an active member of this organization');
    return member;
  }

  private async view(actor: AuthUser, ticketId: number): Promise<TicketView> {
    const view = await this.tickets.findViewById(actor.tenantId, ticketId);
    if (!view) throw new NotFoundError('Ticket', ticketId);
    return view;
  }

  private record(actor: AuthUser, ticketId: number, action: string, metadata: Record<string, unknown>, tx: Executor) {
    return this.audit.record({ tenantId: actor.tenantId, actorId: actor.id, action, entityType: 'TICKET', entityId: ticketId, metadata }, tx);
  }
}
