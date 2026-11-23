import { z } from 'zod';
import { PRIORITIES, TICKET_CHANNELS, TICKET_STATUSES, TICKET_TYPES } from '../model/enums.js';
import { paginationQuery } from './common.dto.js';
import { createContactDto } from './contact.dto.js';

const title = z.string().trim().min(1, 'Title cannot be empty').max(200);
const description = z.string().trim().min(1, 'Description cannot be empty').max(10_000);
const orderRef = z
  .string()
  .trim()
  .max(100)
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

/**
 * Staff record a ticket for an existing contact (`contactId`) or a new one (`contact`).
 * A new contact whose phone number already exists in the organization is reused, not duplicated.
 */
export const createTicketDto = z
  .object({
    contactId: z.number().int().positive().optional(),
    contact: createContactDto.optional(),
    /** The ticket subject. */
    title,
    description,
    type: z.enum(TICKET_TYPES).default('OTHER'),
    priority: z.enum(PRIORITIES).default('NORMAL'),
    channel: z.enum(TICKET_CHANNELS),
    orderRef,
    assigneeId: z.string().min(1).max(64).optional(),
  })
  .refine((v) => (v.contactId === undefined) !== (v.contact === undefined), {
    message: 'Provide either contactId (existing contact) or contact (new contact)',
    path: ['contactId'],
  });
export type CreateTicketInput = z.infer<typeof createTicketDto>;

export const updateTicketDto = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    type: z.enum(TICKET_TYPES).optional(),
    channel: z.enum(TICKET_CHANNELS).optional(),
    assigneeId: z.string().min(1).max(64).nullable().optional(),
    title: title.optional(),
    description: description.optional(),
    orderRef,
    /** Optional optimistic-lock token: send the `version` you last read to detect concurrent edits. */
    version: z.number().int().positive().optional(),
  })
  .refine(
    (v) =>
      [v.status, v.priority, v.type, v.channel, v.assigneeId, v.title, v.description, v.orderRef].some((x) => x !== undefined),
    { message: 'Provide at least one of: status, priority, type, channel, assigneeId, title, description, orderRef' },
  );
export type UpdateTicketInput = z.infer<typeof updateTicketDto>;

export const ticketFilterQuery = paginationQuery.extend({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(TICKET_TYPES).optional(),
  channel: z.enum(TICKET_CHANNELS).optional(),
  assigneeId: z.string().min(1).max(64).optional(),
  contactId: z.coerce.number().int().positive().optional(),
  /** Legacy filter for first-version tickets raised by a customer account. */
  requesterId: z.string().min(1).max(64).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'priority']).default('createdAt'),
  unassigned: z.enum(['true']).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type TicketFilterQuery = z.infer<typeof ticketFilterQuery>;

export const ticketSearchQuery = ticketFilterQuery.extend({
  q: z.string().trim().min(1, 'Search term cannot be empty').max(200),
});
export type TicketSearchQuery = z.infer<typeof ticketSearchQuery>;
