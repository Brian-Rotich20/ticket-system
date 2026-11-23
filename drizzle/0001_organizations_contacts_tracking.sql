-- 0001: organizations with memberships, customer contacts, agent-created tickets, comment visibility, tracking links.
-- Data-preserving: nothing is dropped. Every new NOT NULL column is backfilled before the constraint is added.
-- Legacy columns users.tenant_id, users.role and tickets.requester_id are kept (now nullable / unused for authorization).

-- ---------------------------------------------------------------- enums
CREATE TYPE "public"."comment_visibility" AS ENUM('PUBLIC', 'INTERNAL');--> statement-breakpoint
CREATE TYPE "public"."invitation_status" AS ENUM('PENDING', 'ACCEPTED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('ADMIN', 'AGENT');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('ACTIVE', 'DEACTIVATED');--> statement-breakpoint
CREATE TYPE "public"."ticket_channel" AS ENUM('WHATSAPP', 'INSTAGRAM', 'TIKTOK', 'PHONE', 'EMAIL', 'WEBSITE', 'WALK_IN', 'OTHER');--> statement-breakpoint
-- The new value is not used anywhere in this migration (Postgres forbids using it before the transaction commits).
ALTER TYPE "public"."ticket_status" ADD VALUE 'WAITING_ON_CUSTOMER' BEFORE 'RESOLVED';--> statement-breakpoint
-- MEDIUM -> NORMAL in place: existing rows and the column default follow automatically, order LOW < NORMAL < HIGH < URGENT is kept.
ALTER TYPE "public"."priority" RENAME VALUE 'MEDIUM' TO 'NORMAL';--> statement-breakpoint

-- ticket_type gets a new value set. Keep each ticket's original type in the audit log, then map it.
INSERT INTO "audit_logs" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "metadata")
SELECT "tenant_id", NULL, 'TICKET_TYPE_MIGRATED', 'TICKET', "ticket_id"::text,
       jsonb_build_object('from', "type"::text, 'to', CASE "type"::text WHEN 'INQUIRY' THEN 'PRODUCT_INQUIRY' ELSE 'OTHER' END)
FROM "tickets";--> statement-breakpoint
CREATE TYPE "public"."ticket_type_v2" AS ENUM('ORDER_ISSUE', 'DELIVERY', 'PAYMENT', 'RETURN_REFUND', 'PRODUCT_INQUIRY', 'COMPLAINT', 'OTHER');--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "type" SET DATA TYPE "public"."ticket_type_v2"
  USING (CASE "type"::text WHEN 'INQUIRY' THEN 'PRODUCT_INQUIRY' ELSE 'OTHER' END)::"public"."ticket_type_v2";--> statement-breakpoint
DROP TYPE "public"."ticket_type";--> statement-breakpoint
ALTER TYPE "public"."ticket_type_v2" RENAME TO "ticket_type";--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "type" SET DEFAULT 'OTHER';--> statement-breakpoint

-- ---------------------------------------------------------------- organizations
ALTER TABLE "tenants" ADD COLUMN "logo" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "ticket_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- accounts created from now on are not bound to a single tenant
ALTER TABLE "users" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint

CREATE TABLE "organization_members" (
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "member_role" NOT NULL,
	"status" "member_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_pk" PRIMARY KEY("tenant_id","user_id")
);--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_members_user" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
-- existing staff keep their access: global ADMIN/AGENT role -> membership of their tenant
INSERT INTO "organization_members" ("tenant_id", "user_id", "role", "status", "created_at")
SELECT "tenant_id", "id", "role"::text::"public"."member_role", 'ACTIVE', "created_at"
FROM "users" WHERE "tenant_id" IS NOT NULL AND "role" IN ('ADMIN', 'AGENT');--> statement-breakpoint
-- any other user still assigned to a ticket gets an inactive membership, so the assignee constraint below holds
-- without granting access (this only happens with inconsistent first-version data)
INSERT INTO "organization_members" ("tenant_id", "user_id", "role", "status")
SELECT DISTINCT "tenant_id", "assignee_id", 'AGENT'::"public"."member_role", 'DEACTIVATED'::"public"."member_status"
FROM "tickets" WHERE "assignee_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

CREATE TABLE "invitations" (
	"invitation_id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" "member_role" DEFAULT 'AGENT' NOT NULL,
	"token_hash" text NOT NULL,
	"status" "invitation_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by" text NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_invitations_tenant_created" ON "invitations" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invitations_pending_email" ON "invitations" USING btree ("tenant_id","email") WHERE "invitations"."status" = 'PENDING';--> statement-breakpoint

-- ---------------------------------------------------------------- contacts
CREATE TABLE "contacts" (
	"contact_id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(120) NOT NULL,
	"phone" varchar(32),
	"email" varchar(255),
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_contacts_tenant_contact" UNIQUE("tenant_id","contact_id")
);--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_contacts_tenant_phone" ON "contacts" USING btree ("tenant_id","phone") WHERE "contacts"."phone" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_contacts_tenant_user" ON "contacts" USING btree ("tenant_id","user_id") WHERE "contacts"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_contacts_tenant_email" ON "contacts" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "idx_contacts_tenant_created" ON "contacts" USING btree ("tenant_id","created_at");--> statement-breakpoint
-- one contact per (organization, account that raised tickets), linked back to the account
INSERT INTO "contacts" ("tenant_id", "name", "email", "user_id", "created_at")
SELECT DISTINCT ON (t."tenant_id", t."requester_id") t."tenant_id", left(u."name", 120), u."email", u."id", u."created_at"
FROM "tickets" t JOIN "users" u ON u."id" = t."requester_id"
ORDER BY t."tenant_id", t."requester_id";--> statement-breakpoint

-- ---------------------------------------------------------------- tickets
ALTER TABLE "tickets" ADD COLUMN "ticket_number" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "contact_id" bigint;--> statement-breakpoint
-- first-version tickets were raised by customers in the web portal
ALTER TABLE "tickets" ADD COLUMN "channel" "ticket_channel" DEFAULT 'WEBSITE' NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "channel" SET DEFAULT 'OTHER';--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "order_ref" varchar(100);--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "tickets" t SET "contact_id" = c."contact_id", "created_by" = t."requester_id"
FROM "contacts" c WHERE c."tenant_id" = t."tenant_id" AND c."user_id" = t."requester_id";--> statement-breakpoint
-- numbers follow creation order inside each organization
UPDATE "tickets" t SET "ticket_number" = n."rn"
FROM (SELECT "ticket_id", row_number() OVER (PARTITION BY "tenant_id" ORDER BY "created_at", "ticket_id") AS "rn" FROM "tickets") n
WHERE n."ticket_id" = t."ticket_id";--> statement-breakpoint
UPDATE "tenants" o SET "ticket_counter" = m."max_number"
FROM (SELECT "tenant_id", max("ticket_number") AS "max_number" FROM "tickets" GROUP BY "tenant_id") m
WHERE m."tenant_id" = o."id";--> statement-breakpoint
-- resolution / closure dates: the latest matching status change in the audit log, else the last update
UPDATE "tickets" t SET "resolved_at" = coalesce(
  (SELECT max(a."created_at") FROM "audit_logs" a WHERE a."tenant_id" = t."tenant_id" AND a."entity_type" = 'TICKET'
     AND a."entity_id" = t."ticket_id"::text AND a."action" = 'TICKET_STATUS_CHANGED' AND a."metadata"->>'to' = 'RESOLVED'),
  t."updated_at")
WHERE t."status" IN ('RESOLVED', 'CLOSED');--> statement-breakpoint
UPDATE "tickets" t SET "closed_at" = coalesce(
  (SELECT max(a."created_at") FROM "audit_logs" a WHERE a."tenant_id" = t."tenant_id" AND a."entity_type" = 'TICKET'
     AND a."entity_id" = t."ticket_id"::text AND a."action" = 'TICKET_STATUS_CHANGED' AND a."metadata"->>'to' = 'CLOSED'),
  t."updated_at")
WHERE t."status" = 'CLOSED';--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "ticket_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "contact_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "requester_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "uq_tickets_tenant_ticket" UNIQUE("tenant_id","ticket_id");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "uq_tickets_tenant_number" UNIQUE("tenant_id","ticket_number");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "fk_tickets_contact_same_tenant" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "public"."contacts"("tenant_id","contact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "fk_tickets_assignee_member" FOREIGN KEY ("tenant_id","assignee_id") REFERENCES "public"."organization_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tickets_tenant_contact" ON "tickets" USING btree ("tenant_id","contact_id");--> statement-breakpoint

-- ---------------------------------------------------------------- comments and attachments
-- everything written before this migration was visible to the customer, so it stays PUBLIC; new rows default to INTERNAL
ALTER TABLE "comments" ADD COLUMN "visibility" "comment_visibility" DEFAULT 'PUBLIC' NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "visibility" SET DEFAULT 'INTERNAL';--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "author_contact_id" bigint;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "comments" SET "updated_at" = "created_at";--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "author_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_contact_id_contacts_contact_id_fk" FOREIGN KEY ("author_contact_id") REFERENCES "public"."contacts"("contact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "ck_comments_has_author" CHECK ("comments"."author_id" is not null or "comments"."author_contact_id" is not null);--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "ck_comments_contact_public" CHECK ("comments"."author_contact_id" is null or "comments"."visibility" = 'PUBLIC');--> statement-breakpoint

ALTER TABLE "attachments" ADD COLUMN "visibility" "comment_visibility" DEFAULT 'PUBLIC' NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "visibility" SET DEFAULT 'INTERNAL';--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "comment_id" bigint;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_comment_id_comments_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("comment_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------- tracking links
CREATE TABLE "ticket_tracking_tokens" (
	"tracking_token_id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"ticket_id" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_tracking_tokens_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint
ALTER TABLE "ticket_tracking_tokens" ADD CONSTRAINT "ticket_tracking_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_tracking_tokens" ADD CONSTRAINT "fk_tracking_ticket_same_tenant" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."tickets"("tenant_id","ticket_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tracking_active_per_ticket" ON "ticket_tracking_tokens" USING btree ("ticket_id") WHERE "ticket_tracking_tokens"."revoked_at" is null;
