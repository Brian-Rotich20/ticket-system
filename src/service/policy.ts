import { ForbiddenError, NotFoundError } from '../exception/errors.js';
import type { TicketStatus } from '../model/enums.js';
import type { Actor } from './actor.js';

/**
 * Role-based permissions (User / Agent / Admin). Pure functions, so they are trivially unit-testable.
 * Rule of thumb:
 *   CUSTOMER  - sees and comments on own tickets; may close own RESOLVED ticket
 *   AGENT     - sees all tickets; works only on tickets assigned to them (or self-assigns an unassigned one)
 *   ADMIN     - everything, including re-assignment of in-progress tickets
 */
interface TicketLike {
  requesterId: number;
  assigneeId: number | null;
}

const isStaff = (a: Actor) => a.role === 'AGENT' || a.role === 'ADMIN';

export function canView(actor: Actor, t: TicketLike): boolean {
  return isStaff(actor) || t.requesterId === actor.userId;
}

/** Customers get 404 (not 403) for tickets they don't own, so ticket ids can't be probed. */
export function assertCanView(actor: Actor, t: TicketLike & { ticketId: number }): void {
  if (!canView(actor, t)) throw new NotFoundError('Ticket', t.ticketId);
}

export function assertCanAssign(actor: Actor, t: Pick<TicketLike, 'assigneeId'>, newAssigneeId: number | null): void {
  if (actor.role === 'ADMIN') return;
  const selfAssign = actor.role === 'AGENT' && t.assigneeId === null && newAssigneeId === actor.userId;
  if (!selfAssign) {
    throw new ForbiddenError('Agents can only assign unassigned tickets to themselves; ask an admin to reassign');
  }
}

export function assertCanChangeStatus(actor: Actor, t: TicketLike, from: TicketStatus, to: TicketStatus): void {
  if (actor.role === 'ADMIN') return;
  if (actor.role === 'AGENT' && t.assigneeId === actor.userId) return;
  if (actor.role === 'CUSTOMER' && t.requesterId === actor.userId && from === 'RESOLVED' && to === 'CLOSED') return;
  throw new ForbiddenError('You are not allowed to change this ticket\'s status');
}

export function assertCanChangePriority(actor: Actor, t: Pick<TicketLike, 'assigneeId'>): void {
  if (actor.role === 'ADMIN' || (actor.role === 'AGENT' && t.assigneeId === actor.userId)) return;
  throw new ForbiddenError('Only the assigned agent or an admin can change priority');
}

export function assertRole(actor: Actor, ...roles: Actor['role'][]): void {
  if (!roles.includes(actor.role)) throw new ForbiddenError();
}

export function isAdmin(actor: Actor): boolean {
  return actor.role === 'ADMIN';
}
