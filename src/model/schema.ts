import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { PRIORITIES, TICKET_STATUSES, TICKET_TYPES, USER_ROLES } from './enums.js';

export const ticketStatusEnum = pgEnum('ticket_status', TICKET_STATUSES);
export const ticketTypeEnum = pgEnum('ticket_type', TICKET_TYPES);
export const priorityEnum = pgEnum('priority', PRIORITIES);
export const userRoleEnum = pgEnum('user_role', USER_ROLES);

const ts = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const id = (name: string) => bigserial(name, { mode: 'number' }).primaryKey(); // numeric ids: tickets, comments, attachments, audit
const fk = (name: string) => bigint(name, { mode: 'number' }); // FK to a numeric id
const userFk = (name: string) => text(name); // user ids are strings (Better Auth)

/** A tenant = one business/store. `id` is a slug such as "acme-store". */
export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  createdAt: ts('created_at'),
});

// ---- Better Auth tables (adapter maps them by key: user, session, account, verification) ----
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    role: userRoleEnum('role').notNull().default('CUSTOMER'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [index('idx_users_tenant_role').on(t.tenantId, t.role)],
);

export const sessions = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
});

export const accounts = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'), // Better Auth owns hashing
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
});

export const verifications = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
});

// ---- Support domain ----
export const tickets = pgTable(
  'tickets',
  {
    ticketId: id('ticket_id'),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description').notNull(),
    /** Structured classification: customer inquiry, IT request or internal issue. */
    type: ticketTypeEnum('type').notNull().default('INQUIRY'),
    status: ticketStatusEnum('status').notNull().default('OPEN'),
    priority: priorityEnum('priority').notNull().default('MEDIUM'),
    requesterId: userFk('requester_id').notNull().references(() => users.id),
    assigneeId: userFk('assignee_id').references(() => users.id),
    /** Optimistic-lock counter: bumped on every ticket mutation (concurrent-update edge case). */
    version: integer('version').notNull().default(1),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  // every query is tenant-scoped, so every index starts with tenant_id
  (t) => [
    index('idx_tickets_tenant_status').on(t.tenantId, t.status),
    index('idx_tickets_tenant_type').on(t.tenantId, t.type),
    index('idx_tickets_tenant_assignee').on(t.tenantId, t.assigneeId),
    index('idx_tickets_tenant_requester').on(t.tenantId, t.requesterId),
    index('idx_tickets_tenant_created').on(t.tenantId, t.createdAt),
  ],
);

export const comments = pgTable(
  'comments',
  {
    commentId: id('comment_id'),
    ticketId: fk('ticket_id').notNull().references(() => tickets.ticketId, { onDelete: 'cascade' }),
    authorId: userFk('author_id').notNull().references(() => users.id),
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
    /** Storage key (Cloudinary public id / local path). Clients never see it; downloads go through the API. */
    fileUrl: text('file_url').notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    fileType: varchar('file_type', { length: 100 }).notNull(),
    uploadedBy: userFk('uploaded_by').notNull().references(() => users.id),
    createdAt: ts('created_at'),
  },
  (t) => [index('idx_attachments_ticket_id').on(t.ticketId)],
);

/** Audit trail: who did what and when. Written in the same transaction as the change it describes. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    auditId: id('audit_id'),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    actorId: userFk('actor_id').references(() => users.id),
    action: varchar('action', { length: 60 }).notNull(),
    entityType: varchar('entity_type', { length: 30 }).notNull(),
    entityId: text('entity_id').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: ts('created_at'),
  },
  (t) => [
    index('idx_audit_tenant_entity').on(t.tenantId, t.entityType, t.entityId),
    index('idx_audit_tenant_created').on(t.tenantId, t.createdAt),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;