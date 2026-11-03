import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { PRIORITIES, TICKET_STATUSES, USER_ROLES } from './enums.js';

export const ticketStatusEnum = pgEnum('ticket_status', TICKET_STATUSES);
export const priorityEnum = pgEnum('priority', PRIORITIES);
export const userRoleEnum = pgEnum('user_role', USER_ROLES);

const ts = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const id = (name: string) => bigserial(name, { mode: 'number' }).primaryKey();
const fk = (name: string) => bigint(name, { mode: 'number' });

export const users = pgTable('users', {
  userId: id('user_id'),
  name: varchar('name', { length: 120 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: userRoleEnum('role').notNull().default('CUSTOMER'),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
});

export const tickets = pgTable(
  'tickets',
  {
    ticketId: id('ticket_id'),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description').notNull(),
    status: ticketStatusEnum('status').notNull().default('OPEN'),
    priority: priorityEnum('priority').notNull().default('MEDIUM'),
    requesterId: fk('requester_id').notNull().references(() => users.userId),
    assigneeId: fk('assignee_id').references(() => users.userId),
    /** Optimistic-lock counter: bumped on every ticket mutation (concurrent-update edge case). */
    version: integer('version').notNull().default(1),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    index('idx_tickets_status').on(t.status),
    index('idx_tickets_assignee_id').on(t.assigneeId),
    index('idx_tickets_requester_id').on(t.requesterId),
    index('idx_tickets_created_at').on(t.createdAt),
  ],
);

export const comments = pgTable(
  'comments',
  {
    commentId: id('comment_id'),
    ticketId: fk('ticket_id').notNull().references(() => tickets.ticketId, { onDelete: 'cascade' }),
    authorId: fk('author_id').notNull().references(() => users.userId),
    text: text('text').notNull(),
    createdAt: ts('created_at'),
  },
  (t) => [index('idx_comments_ticket_id').on(t.ticketId)],
);

export const attachments = pgTable(
  'attachments',
  {
    attachmentId: id('attachment_id'),
    ticketId: fk('ticket_id').notNull().references(() => tickets.ticketId, { onDelete: 'cascade' }),
    /** Storage key (local path or S3 key). The public/download URL is resolved by AttachmentService. */
    fileUrl: text('file_url').notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    fileType: varchar('file_type', { length: 100 }).notNull(),
    uploadedBy: fk('uploaded_by').notNull().references(() => users.userId),
    createdAt: ts('created_at'),
  },
  (t) => [index('idx_attachments_ticket_id').on(t.ticketId)],
);

/** Audit trail: who did what and when. Written in the same transaction as the change it describes. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    auditId: id('audit_id'),
    actorId: fk('actor_id').references(() => users.userId),
    action: varchar('action', { length: 60 }).notNull(),
    entityType: varchar('entity_type', { length: 30 }).notNull(),
    entityId: fk('entity_id').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: ts('created_at'),
  },
  (t) => [index('idx_audit_entity').on(t.entityType, t.entityId), index('idx_audit_created_at').on(t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
