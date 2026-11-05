import type { AuthUser } from '../auth/auth-user.js';
import { ForbiddenError, NotFoundError } from '../exception/errors.js';
import type { TicketStatus, UserRole } from '../model/enums.js';

/**
 * Ownership / assignment rules that depend on the ticket itself (route-level role checks are the
 * requireAuth / verifyRole hooks).
 *   CUSTOMER  sees and comments on own tickets only
 *   AGENT     sees all tickets of the tenant; works only on tickets assigned to them (or self-assigns an unassigned one)
 *   ADMIN     everything in the tenant, including re-assigning IN_PROGRESS tickets
 */
interface TicketLike {
  tenantId: string;
  requesterId: string;
  assigneeId: string | null;
}

export const isAdmin = (u: AuthUser) => u.role === 'ADMIN';
export const isStaff = (u: AuthUser) => u.role === 'AGENT' || u.role === 'ADMIN';

export function assertRole(u: AuthUser, ...roles: UserRole[]): void {
  if (!roles.includes(u.role)) throw new ForbiddenError();
}

export const canView = (actor: AuthUser, t: TicketLike): boolean =>
  t.tenantId === actor.tenantId && (isStaff(actor) || t.requesterId === actor.id);

/** Customers get 404 (not 403) for tickets they cannot see, so ticket ids can't be probed. */
export function assertCanView(actor: AuthUser, t: TicketLike & { ticketId: number }): void {
  if (!canView(actor, t)) throw new NotFoundError('Ticket', t.ticketId);
}

export function assertCanAssign(actor: AuthUser, t: Pick<TicketLike, 'assigneeId'>, newAssigneeId: string | null): void {
  if (actor.role === 'ADMIN') return;
  const selfAssign = actor.role === 'AGENT' && t.assigneeId === null && newAssigneeId === actor.id;
  if (!selfAssign) throw new ForbiddenError('Agents can only assign unassigned tickets to themselves; ask an admin to reassign');
}

export function assertCanChangeStatus(actor: AuthUser, t: Pick<TicketLike, 'assigneeId'>, _from: TicketStatus, _to: TicketStatus): void {
  if (actor.role === 'ADMIN' || (actor.role === 'AGENT' && t.assigneeId === actor.id)) return;
  throw new ForbiddenError("You are not allowed to change this ticket's status");
}

/** Triage = changing priority or classification (type). */
export function assertCanTriage(actor: AuthUser, t: Pick<TicketLike, 'assigneeId'>): void {
  if (actor.role === 'ADMIN' || (actor.role === 'AGENT' && t.assigneeId === actor.id)) return;
  throw new ForbiddenError('Only the assigned agent or an admin can change priority or type');
}