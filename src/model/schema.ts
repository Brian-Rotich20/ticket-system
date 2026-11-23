import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  COMMENT_VISIBILITIES,
  INVITATION_STATUSES,
  MEMBER_ROLES,
  MEMBER_STATUSES,
  PRIORITIES,
  TICKET_CHANNELS,
  TICKET_STATUSES,
  TICKET_TYPES,
  USER_ROLES,
} from './enums.js';

export const ticketStatusEnum = pgEnum('ticket_status', TICKET_STATUSES);
export const ticketTypeEnum = pgEnum('ticket_type', TICKET_TYPES);
export const priorityEnum = pgEnum('priority', PRIORITIES);
export const ticketChannelEnum = pgEnum('ticket_channel', TICKET_CHANNELS);
export const commentVisibilityEnum = pgEnum('comment_visibility', COMMENT_VISIBILITIES);
export const userRoleEnum = pgEnum('user_role', USER_ROLES);
export const memberRoleEnum = pgEnum('member_role', MEMBER_ROLES);
export const memberStatusEnum = pgEnum('member_status', MEMBER_STATUSES);
export const invitationStatusEnum = pgEnum('invitation_status', INVITATION_STATUSES);

const ts = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const tsNullable = (name: string) => timestamp(name, { withTimezone: true });
const id = (name: string) => bigserial(name, { mode: 'number' }).primaryKey(); // numeric ids: tickets, comments, attachments, audit
const fk = (name: string) => bigint(name, { mode: 'number' }); // FK to a numeric id
const userFk = (name: string) => text(name); // user ids are strings (Better Auth)

/**
 * A tenant = one organization (business/store). `id` is its URL slug, such as "acme-store".
 * Table and column names (`tenants`, `tenant_id`) are kept from the first version of the schema.
 */
export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  /** Public logo URL shown on the customer tracking page. */
  logo: text('logo'),
  /** Last ticket number handed out in this organization (see TicketRepository.nextTicketNumber). */
  ticketCounter: integer('ticket_counter').notNull().default(0),
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
    /** Legacy: the single tenant of a first-version account. Authorization uses organization_members. */
    tenantId: text('tenant_id').references(() => tenants.id),
    /** Legacy global role. Authorization uses organization_members.role. */
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

// ---- Organizations: membership and invitations ----
/** Organization-specific role and status. A user may belong to many organizations. */
export const organizationMembers = pgTable(
  'organization_members',
  {
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    userId: userFk('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').notNull(),
    status: memberStatusEnum('status').notNull().default('ACTIVE'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [primaryKey({ name: 'organization_members_pk', columns: [t.tenantId, t.userId] }), index('idx_members_user').on(t.userId)],
);

export const invitations = pgTable(
  'invitations',
  {
    invitationId: id('invitation_id'),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    email: varchar('email', { length: 255 }).notNull(), // stored lower-cased
    role: memberRoleEnum('role').notNull().default('AGENT'),
    /** SHA-256 of the invitation token. The raw token is only ever shown once, to the inviting admin. */
    tokenHash: text('token_hash').notNull().unique(),
    status: invitationStatusEnum('status').notNull().default('PENDING'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    invitedBy: userFk('invited_by').notNull().references(() => users.id),
    acceptedBy: userFk('accepted_by').references(() => users.id),
    acceptedAt: tsNullable('accepted_at'),
    createdAt: ts('created_at'),
  },
  (t) => [
    index('idx_invitations_tenant_created').on(t.tenantId, t.createdAt),
    // at most one pending invitation per email and organization
    uniqueIndex('uq_invitations_pending_email').on(t.tenantId, t.email).where(sql`${t.status} = 'PENDING'`),
  ],
);

// ---- Customer contacts: the customers of a business. They do not have accounts. ----
export const contacts = pgTable(
  'contacts',
  {
    contactId: id('contact_id'),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    name: varchar('name', { length: 120 }).notNull(),
    /** Normalised (spaces, dashes and brackets removed). Unique per organization, never globally. */
    phone: varchar('phone', { length: 32 }),
    email: varchar('email', { length: 255 }),
    /** Optional link to a platform account (customers migrated from the first version). */
    userId: userFk('user_id').references(() => users.id),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    unique('uq_contacts_tenant_contact').on(t.tenantId, t.contactId), // target of composite FKs
    uniqueIndex('uq_contacts_tenant_phone').on(t.tenantId, t.phone).where(sql`${t.phone} is not null`),
    uniqueIndex('uq_contacts_tenant_user').on(t.tenantId, t.userId).where(sql`${t.userId} is not null`),
    index('idx_contacts_tenant_email').on(t.tenantId, t.email),
    index('idx_contacts_tenant_created').on(t.tenantId, t.createdAt),
  ],
);

// ---- Support domain ----
export const tickets = pgTable(
  'tickets',
  {
    ticketId: id('ticket_id'),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    /** Human-facing number, unique and sequential per organization. */
    ticketNumber: integer('ticket_number').notNull(),
    contactId: fk('contact_id').notNull(),
    /** The subject of the ticket. */
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description').notNull(),
    type: ticketTypeEnum('type').notNull().default('OTHER'),
    status: ticketStatusEnum('status').notNull().default('OPEN'),
    priority: priorityEnum('priority').notNull().default('NORMAL'),
    channel: ticketChannelEnum('channel').notNull().default('OTHER'),
    orderRef: varchar('order_ref', { length: 100 }),
    /** Legacy: the customer account that raised a first-version ticket. New tickets use contactId. */
    requesterId: userFk('requester_id').references(() => users.id),
    /** Assigned agent: must be a member of the same organization (composite FK below). */
    assigneeId: userFk('assignee_id').references(() => users.id),
    createdBy: userFk('created_by').notNull().references(() => users.id),
    /** Optimistic-lock counter: bumped on every ticket mutation (concurrent-update edge case). */
    version: integer('version').notNull().default(1),
    resolvedAt: tsNullable('resolved_at'),
    closedAt: tsNullable('closed_at'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  // every query is tenant-scoped, so every index starts with tenant_id
  (t) => [
    unique('uq_tickets_tenant_ticket').on(t.tenantId, t.ticketId), // target of composite FKs
    unique('uq_tickets_tenant_number').on(t.tenantId, t.ticketNumber),
    // the contact and the assignee must belong to the ticket's own organization
    foreignKey({ name: 'fk_tickets_contact_same_tenant', columns: [t.tenantId, t.contactId], foreignColumns: [contacts.tenantId, contacts.contactId] }),
    foreignKey({
      name: 'fk_tickets_assignee_member',
      columns: [t.tenantId, t.assigneeId],
      foreignColumns: [organizationMembers.tenantId, organizationMembers.userId],
    }),
    index('idx_tickets_tenant_status').on(t.tenantId, t.status),
    index('idx_tickets_tenant_type').on(t.tenantId, t.type),
    index('idx_tickets_tenant_assignee').on(t.tenantId, t.assigneeId),
    index('idx_tickets_tenant_requester').on(t.tenantId, t.requesterId),
    index('idx_tickets_tenant_contact').on(t.tenantId, t.contactId),
    index('idx_tickets_tenant_created').on(t.tenantId, t.createdAt),
  ],
);

export const comments = pgTable(
  'comments',
  {
    commentId: id('comment_id'),
    ticketId: fk('ticket_id').notNull().references(() => tickets.ticketId, { onDelete: 'cascade' }),
    /** Staff author (or a legacy customer account). Null when the contact replied through the tracking link. */
    authorId: userFk('author_id').references(() => users.id),
    /** Set when the customer replied through the tracking link. */
    authorContactId: fk('author_contact_id').references(() => contacts.contactId),
    /** The comment body. */
    text: text('text').notNull(),
    /** PUBLIC: shown on the tracking page. INTERNAL: staff only. */
    visibility: commentVisibilityEnum('visibility').notNull().default('INTERNAL'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    index('idx_comments_ticket_id').on(t.ticketId),
    check('ck_comments_has_author', sql`${t.authorId} is not null or ${t.authorContactId} is not null`),
    check('ck_comments_contact_public', sql`${t.authorContactId} is null or ${t.visibility} = 'PUBLIC'`),
  ],
);

export const attachments = pgTable(
  'attachments',
  {
    attachmentId: id('attachment_id'),
    ticketId: fk('ticket_id').notNull().references(() => tickets.ticketId, { onDelete: 'cascade' }),
    commentId: fk('comment_id').references(() => comments.commentId, { onDelete: 'set null' }),
    /** Storage key (Cloudinary public id / local path). Clients never see it; downloads go through the API. */
    fileUrl: text('file_url').notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    fileType: varchar('file_type', { length: 100 }).notNull(),
    /** PUBLIC attachments are downloadable through the tracking link; INTERNAL ones are staff only. */
    visibility: commentVisibilityEnum('visibility').notNull().default('INTERNAL'),
    uploadedBy: userFk('uploaded_by').notNull().references(() => users.id),
    createdAt: ts('created_at'),
  },
  (t) => [index('idx_attachments_ticket_id').on(t.ticketId)],
);

/** Customer tracking links. Only the SHA-256 of the token is stored. At most one non-revoked token per ticket. */
export const trackingTokens = pgTable(
  'ticket_tracking_tokens',
  {
    trackingTokenId: id('tracking_token_id'),
    tenantId: text('tenant_id').notNull(),
    ticketId: fk('ticket_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: tsNullable('revoked_at'),
    createdBy: userFk('created_by').notNull().references(() => users.id),
    createdAt: ts('created_at'),
  },
  (t) => [
    foreignKey({
      name: 'fk_tracking_ticket_same_tenant',
      columns: [t.tenantId, t.ticketId],
      foreignColumns: [tickets.tenantId, tickets.ticketId],
    }).onDelete('cascade'),
    uniqueIndex('uq_tracking_active_per_ticket').on(t.ticketId).where(sql`${t.revokedAt} is null`),
  ],
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
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type TrackingToken = typeof trackingTokens.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
