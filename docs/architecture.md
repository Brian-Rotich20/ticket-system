# Architecture

## Overview

```
Browser  ──►  Next.js (Vercel)
                  │  fetch + Authorization: Bearer <token>
                  ▼
              Fastify API (Render) ──► Neon Postgres
              ├─ Better Auth (/api/auth)      ──► Cloudinary (files)
              └─ Business API (/api/v1)       ──► Email (log only)
```

| Part | Tech |
|---|---|
| Frontend | Next.js (App Router), TypeScript, Tailwind, plain `fetch` |
| Backend | Fastify, TypeScript, Drizzle ORM, zod |
| Auth | Better Auth (email and password, bearer plugin) |
| Database | PostgreSQL on Neon |
| Files | Cloudinary (local disk in development) |
| Tests | Vitest and PGlite (in-process Postgres) |

## Backend layers

```
Controller  → validate input (zod), run role guards, delegate
Service     → business rules, transactions, audit, notifications
Policy      → ownership and assignment rules (pure functions)
Repository  → queries, always scoped by tenant
Database    → Postgres
```

```
backend/src/
  auth/         auth.ts (Better Auth setup), plugin.ts (requireAuth, verifyRole), roles, auth-user
  config/       env, db, constants
  model/        enums, schema (Drizzle)
  dto/          zod request schemas
  repository/   data access
  service/      business logic, policy, notifications, storage
  controller/   routes
  exception/    typed errors → HTTP status
  app.ts        composition root (wiring, CORS, error handler, /api/v1 prefix)
```

## Frontend

```
frontend/src/
  app/          routes: (auth) login and signup; (app) dashboard, tickets, queue, team, audit
  components/   ui/ (one component per file), tickets/, queue/, team/, audit/, auth/
  context/      auth-context (session state)
  lib/          api client, token storage, per-feature API calls, helpers
```

Pages are thin and the feature components do the work. Filters live in the URL, so refresh, Back and shared links keep their state.

## Request lifecycle

1. The browser sends `Authorization: Bearer <token>`.
2. CORS allows only origins in `TRUSTED_ORIGINS`.
3. `requireAuth` resolves the session into `{ id, email, tenantId, role }`.
4. `verifyRole` checks the route's roles.
5. The service checks ownership and rules. It reads tickets with the tenant id and, on writes, locks the row.
6. Change, audit entry and notification events are committed together. Notifications are sent after the commit.

## Multi-tenancy

- One shared database. `tenantId` is on users, tickets and audit logs.
- Comments and attachments are reached only through a tenant-scoped ticket lookup.
- Every index starts with `tenant_id`.
- Sign-up requires an existing tenant (store ID). Only the server can create staff roles.

## Data model

| Table | Key columns |
|---|---|
| `tenants` | `id` (slug), `name` |
| `users` | `id` (text), `email`, `tenant_id`, `role` |
| `session`, `account`, `verification` | Better Auth's tables (the password hash lives in `account`) |
| `tickets` | `ticket_id`, `tenant_id`, `type`, `status`, `priority`, `requester_id`, `assignee_id`, `version` |
| `comments` | `comment_id`, `ticket_id`, `author_id`, `text` |
| `attachments` | `attachment_id`, `ticket_id`, `file_url` (storage key), `file_name`, `file_type`, `uploaded_by` |
| `audit_logs` | `audit_id`, `tenant_id`, `actor_id`, `action`, `entity_type`, `entity_id`, `metadata` |

## Key decisions

| Decision | Why | Trade-off |
|---|---|---|
| Browser calls the API directly (`NEXT_PUBLIC_API_URL`) with a **bearer token in localStorage** | Cookies from `onrender.com` are third-party for a `vercel.app` page and are blocked by some browsers | A script injected into the page could read the token. Keep the content security policy tight. |
| Optimistic locking (`version`) plus `SELECT … FOR UPDATE` | Two agents can't overwrite each other | The client must handle 409 |
| Audit rows written in the same transaction | The log can't disagree with the data | Slightly slower writes |
| Downloads proxied through the API | Access is checked on every download. No public file URLs. | Files pass through the API |
| Names stored on list responses | Customers and agents can't look up other users | Names are joined on read |
| Roles live in `users.role`, set server-side | Nobody can self-register as staff | Staff creation goes through an admin |

## Configuration

| Backend | |
|---|---|
| `DATABASE_URL` | Neon connection string |
| `BETTER_AUTH_SECRET` | 32+ random characters |
| `BETTER_AUTH_URL` | The API's own public URL |
| `TRUSTED_ORIGINS` | Comma-separated frontend origins (CORS and CSRF allowlist) |
| `STORAGE_DRIVER` | `local` or `cloudinary` (needs the three `CLOUDINARY_*` values) |
| `MAX_UPLOAD_BYTES`, `MAX_ATTACHMENTS_PER_TICKET` | Upload limits |

| Frontend | |
|---|---|
| `NEXT_PUBLIC_API_URL` | The backend URL (inlined at build time, so redeploy after changing it) |

## Running and testing

```bash
# backend
npm run dev          # API on :3000
npm test             # integration tests on PGlite
npm run db:migrate   # apply migrations
npm run seed:demo    # demo store, staff, customers, tickets

# frontend
npm run dev          # app on :3001
```

Demo password for all seeded users: `Passw0rd!123` (`admin@acme-store.example`, `wanjiru@acme-store.example`, `amina@example.com`, and others).

## Known limits

- Free-tier cold starts on Render.
- Email notifications are log-only.
- Lists load the first page or the first 100 comments. There is no live updating, so use Refresh.
- Frontend session state is client-side only.