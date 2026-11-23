import type { AuthUser } from '../auth/auth-user.js';
import { ForbiddenError, NotFoundError } from '../exception/errors.js';
import type { MemberRole } from '../model/enums.js';

/**
 * Ticket rules that depend on the ticket itself. Route-level checks (signed in, active member of the organization,
 * role) are the requireAuth / verifyRole hooks. Every caller here is an ACTIVE member of `actor.tenantId`.
 *   AGENT  sees the organization's whole queue; works on unassigned tickets and tickets assigned to them,
 *          and may hand those to another member
 *   ADMIN  everything in the organization, including reassigning another agent's ticket
 */
interface TicketLike {
  tenantId: string;
  assigneeId: string | null;
}

export const isAdmin = (u: AuthUser) => u.role === 'ADMIN';

export function assertRole(u: AuthUser, ...roles: MemberRole[]): void {
  if (!roles.includes(u.role)) throw new ForbiddenError();
}

/** Every member of the organization can see its tickets. */
export const canView = (actor: AuthUser, t: Pick<TicketLike, 'tenantId'>): boolean => t.tenantId === actor.tenantId;

/** Another organization's ticket answers 404 (not 403), so ticket ids can't be probed. */
export function assertCanView(actor: AuthUser, t: Pick<TicketLike, 'tenantId'> & { ticketId: number }): void {
  if (!canView(actor, t)) throw new NotFoundError('Ticket', t.ticketId);
}

/** Status, priority, type and details: admins, the assignee, or anyone while the ticket is unassigned. */
export function assertCanWork(actor: AuthUser, t: Pick<TicketLike, 'assigneeId'>): void {
  if (isAdmin(actor) || t.assigneeId === null || t.assigneeId === actor.id) return;
  throw new ForbiddenError('Only the assigned agent or an admin can change this ticket');
}

/** Agents assign unassigned tickets and hand over their own; reassigning someone else's ticket is admin-only. */
export function assertCanAssign(actor: AuthUser, t: Pick<TicketLike, 'assigneeId'>): void {
  if (isAdmin(actor) || t.assigneeId === null || t.assigneeId === actor.id) return;
  throw new ForbiddenError("Only an admin can reassign another agent's ticket");
}
