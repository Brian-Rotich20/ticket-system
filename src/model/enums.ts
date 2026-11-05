export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export const TICKET_TYPES = ['INQUIRY', 'IT_REQUEST', 'INTERNAL_ISSUE'] as const;
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export const USER_ROLES = ['CUSTOMER', 'AGENT', 'ADMIN'] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketType = (typeof TICKET_TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type UserRole = (typeof USER_ROLES)[number];

/** Ticket Status Flow: OPEN -> IN_PROGRESS -> RESOLVED -> CLOSED. Transitions are explicit and validated. */
export const ALLOWED_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ['IN_PROGRESS'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}