import { ForbiddenError, NotFoundError } from '../exception/errors.js';
import type { TicketStatus } from '../model/enums.js';
import type { AuthUser } from '../auth/auth-user.js'

/**
 * Role-based permissions (User / Agent / Admin). Pure functions, so they are trivially unit-testable.
 * Rule of thumb:
 *   CUSTOMER  - sees and comments on own tickets; may close own RESOLVED ticket
 *   AGENT     - sees all tickets; works only on tickets assigned to them (or self-assigns an unassigned one)
 *   ADMIN     - everything, including re-assignment of in-progress tickets
 */
interface TicketLike {
  tenantId: string;
  requesterId: string;
  assigneeId: string | null;
}

const isStaff = (a: AuthUser) => a.role === 'AGENT' || a.role === 'ADMIN';

export const canView = (actor: AuthUser, t: TicketLike) =>
  t.tenantId === actor.tenantId && (isStaff(actor) || t.requesterId === actor.id);


/** Customers get 404 (not 403) for tickets they don't own, so ticket ids can't be probed. */
export function assertCanView(actor: AuthUser, t: TicketLike & { ticketId: string }): void {
  if (!canView(actor, t)) throw new NotFoundError('Ticket', t.ticketId);
}

export function assertCanAssign(actor: AuthUser, t: Pick<TicketLike, 'assigneeId'>, newAssigneeId: string | null): void {
  if (actor.role === 'ADMIN') return;
  const selfAssign = actor.role === 'AGENT' && t.assigneeId === null && newAssigneeId === actor.id;
  if (!selfAssign) {
    throw new ForbiddenError('Agents can only assign unassigned tickets to themselves; ask an admin to reassign');
  }
}

export function assertCanChangeStatus(actor: AuthUser, t: TicketLike, from: TicketStatus, to: TicketStatus): void {
  if (actor.role === 'ADMIN') return;
  if (actor.role === 'AGENT' && t.assigneeId === actor.id) return;
  if (actor.role === 'CUSTOMER' && t.requesterId === actor.id && from === 'RESOLVED' && to === 'CLOSED') return;
  throw new ForbiddenError('You are not allowed to change this ticket\'s status');
}

export function assertCanTriage(actor: AuthUser, t: Pick<TicketLike, 'assigneeId'>): void {
  if (actor.role === 'ADMIN' || (actor.role === 'AGENT' && t.assigneeId === actor.id)) return;
  throw new ForbiddenError('Only the assigned agent or an admin can change priority');
}

export function assertRole(actor: AuthUser, ...roles: AuthUser['role'][]): void {
  if (!roles.includes(actor.role)) throw new ForbiddenError();
}

export function isAdmin(actor: AuthUser): boolean {
  return actor.role === 'ADMIN';
}
