import { z } from 'zod';
import { PRIORITIES, TICKET_STATUSES } from '../model/enums.js';
import { paginationQuery } from './common.dto.js';

// "Title and description cannot be empty"; "Priority and status must be valid enum values"
export const createTicketDto = z.object({
  title: z.string().trim().min(1, 'Title cannot be empty').max(200),
  description: z.string().trim().min(1, 'Description cannot be empty').max(10_000),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
});
export type CreateTicketInput = z.infer<typeof createTicketDto>;

export const updateTicketDto = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assigneeId: z.number().int().positive().nullable().optional(),
    /** Optional optimistic-lock token: send the `version` you last read to detect concurrent edits. */
    version: z.number().int().positive().optional(),
  })
  .refine((v) => v.status !== undefined || v.priority !== undefined || v.assigneeId !== undefined, {
    message: 'Provide at least one of: status, priority, assigneeId',
  });
export type UpdateTicketInput = z.infer<typeof updateTicketDto>;

export const ticketFilterQuery = paginationQuery.extend({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: z.coerce.number().int().positive().optional(),
  requesterId: z.coerce.number().int().positive().optional(),
  sortBy: z.enum(['createdAt', 'updatedAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type TicketFilterQuery = z.infer<typeof ticketFilterQuery>;

export const ticketSearchQuery = ticketFilterQuery.extend({
  q: z.string().trim().min(1, 'Search term cannot be empty').max(200),
});
export type TicketSearchQuery = z.infer<typeof ticketSearchQuery>;
