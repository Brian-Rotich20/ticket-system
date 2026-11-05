import { z } from 'zod';
import { PRIORITIES, TICKET_STATUSES, TICKET_TYPES } from '../model/enums.js';
import { paginationQuery } from './common.dto.js';

// "Title and description cannot be empty"; "Priority and status must be valid enum values"
export const createTicketDto = z.object({
  title: z.string().trim().min(1, 'Title cannot be empty').max(200),
  description: z.string().trim().min(1, 'Description cannot be empty').max(10_000),
  type: z.enum(TICKET_TYPES).default('INQUIRY'),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
});
export type CreateTicketInput = z.infer<typeof createTicketDto>;

export const updateTicketDto = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    type: z.enum(TICKET_TYPES).optional(),
    assigneeId: z.string().min(1).max(64).nullable().optional(),
    /** Optional optimistic-lock token: send the `version` you last read to detect concurrent edits. */
    version: z.number().int().positive().optional(),
  })
  .refine((v) => v.status !== undefined || v.priority !== undefined || v.type !== undefined || v.assigneeId !== undefined, {
    message: 'Provide at least one of: status, priority, type, assigneeId',
  });
export type UpdateTicketInput = z.infer<typeof updateTicketDto>;

export const ticketFilterQuery = paginationQuery.extend({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(TICKET_TYPES).optional(),
  assigneeId: z.string().min(1).max(64).optional(),
  requesterId: z.string().min(1).max(64).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type TicketFilterQuery = z.infer<typeof ticketFilterQuery>;

export const ticketSearchQuery = ticketFilterQuery.extend({
  q: z.string().trim().min(1, 'Search term cannot be empty').max(200),
});
export type TicketSearchQuery = z.infer<typeof ticketSearchQuery>;