export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;
export const TICKET_TYPES = ['ORDER_ISSUE', 'DELIVERY', 'PAYMENT', 'RETURN_REFUND', 'PRODUCT_INQUIRY', 'COMPLAINT', 'OTHER'] as const;
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
/** Where the customer raised the issue. Recorded only: there is no integration with these channels. */
export const TICKET_CHANNELS = ['WHATSAPP', 'INSTAGRAM', 'TIKTOK', 'PHONE', 'EMAIL', 'WEBSITE', 'WALK_IN', 'OTHER'] as const;
export const COMMENT_VISIBILITIES = ['PUBLIC', 'INTERNAL'] as const;
/** Legacy global role on `users.role`. No longer used for authorization: see MEMBER_ROLES. */
export const USER_ROLES = ['CUSTOMER', 'AGENT', 'ADMIN'] as const;
/** Organization-specific role, held on `organization_members`. */
export const MEMBER_ROLES = ['ADMIN', 'AGENT'] as const;
export const MEMBER_STATUSES = ['ACTIVE', 'DEACTIVATED'] as const;
export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED'] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketType = (typeof TICKET_TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type TicketChannel = (typeof TICKET_CHANNELS)[number];
export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number];
export type UserRole = (typeof USER_ROLES)[number];
export type MemberRole = (typeof MEMBER_ROLES)[number];
export type MemberStatus = (typeof MEMBER_STATUSES)[number];
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * Ticket status flow. CLOSED is final; RESOLVED can be reopened.
 *   OPEN -> IN_PROGRESS | WAITING_ON_CUSTOMER | RESOLVED
 *   IN_PROGRESS <-> WAITING_ON_CUSTOMER, both -> RESOLVED
 *   RESOLVED -> CLOSED | IN_PROGRESS (reopen)
 */
export const ALLOWED_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ['IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED'],
  IN_PROGRESS: ['WAITING_ON_CUSTOMER', 'RESOLVED'],
  WAITING_ON_CUSTOMER: ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: [],
};

/** A customer reply through the tracking link moves these statuses back to IN_PROGRESS. */
export const REOPEN_ON_CUSTOMER_REPLY: readonly TicketStatus[] = ['WAITING_ON_CUSTOMER', 'RESOLVED'];

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}