# Support Desk API (backend)

Multi-tenant customer support ticketing API. Businesses ("tenants", e.g. one store or ISP) track customer problems as tickets with owners, status, comments, files and an audit trail.

| | |
|---|---|
| Runtime | Node.js 22+ |
| Framework | Fastify 5, TypeScript, zod |
| Database | PostgreSQL (Neon) via Drizzle ORM |
| Auth | Better Auth: email and password, bearer token |
| Files | Cloudinary (local disk in development) |
| Tests | Vitest + PGlite (in-process Postgres, no database needed) |
| Deploy | Render |

Docs: [`../docs/api.md`](../docs/api.md) (endpoints), [`../docs/architecture.md`](../docs/architecture.md), [`../docs/requirements.md`](../docs/requirements.md).

## Quick start

```bash
cd backend
npm install
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
# edit .env: DATABASE_URL, BETTER_AUTH_SECRET, TRUSTED_ORIGINS
npm run db:migrate            # create tables
npm run seed:demo             # demo store, staff, customers, tickets
npm run dev                   # http://localhost:3000
```

```bash
curl http://localhost:3000/health          # {"status":"ok"}
curl http://localhost:3000/api/v1/public/tenants/acme-store
```

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon connection string, with `?sslmode=require` |
| `BETTER_AUTH_SECRET` | yes | 32+ random characters |
| `BETTER_AUTH_URL` | yes | This API's own public URL (`http://localhost:3000` locally) |
| `TRUSTED_ORIGINS` | yes | Comma-separated frontend origins, no trailing slash. Used for CORS **and** Better Auth's origin check. |
| `APP_URL` | no | Public URL of the web app. Tracking and invitation links are built from it (they are always returned as paths too). |
| `TRUST_PROXY_HOPS` | no | Reverse proxies in front of the API. Set `1` on Render so rate limiting sees the client IP. Default `0`. |
| `TRACKING_TOKEN_TTL_DAYS`, `INVITATION_TTL_DAYS` | no | Link lifetimes. Defaults 30 and 7 days. |
| `PORT`, `HOST` | no | Default `3000`, `0.0.0.0`. Render sets `PORT` itself. |
| `STORAGE_DRIVER` | no | `local` (default) or `cloudinary` |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | if `cloudinary` | Startup fails if any is missing |
| `CLOUDINARY_FOLDER` | no | Default `ticket-system` |
| `UPLOAD_DIR` | no | Local storage folder, default `./uploads` |
| `MAX_UPLOAD_BYTES` | no | Default 5 MB |
| `MAX_ATTACHMENTS_PER_TICKET` | no | Default 10 |

Example for local development with the web app on port 3001:

```dotenv
DATABASE_URL=postgres://user:password@ep-xxxx.neon.tech/neondb?sslmode=require
BETTER_AUTH_SECRET=<32+ random characters>
BETTER_AUTH_URL=http://localhost:3000
TRUSTED_ORIGINS=http://localhost:3001
STORAGE_DRIVER=local
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | API with auto-reload, reads `.env` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server (`dist/src/server.js`) |
| `npm test` | Integration tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate -- --name <name>` | Generate a migration from `src/model/schema.ts` |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` |
| `npm run seed:demo` | Demo business with staff, contacts and tickets (skips if already seeded; refuses to run with `NODE_ENV=production`) |

### Changing the schema

1. Edit `src/model/schema.ts`.
2. `npm run db:generate -- --name <what_changed>`, then read the generated SQL in `drizzle/`.
3. `npm run db:migrate`.
4. Commit the migration. The tests apply everything in `drizzle/`.

### Create your own business and admin

Register through the API (or the web app's sign-up page). It creates the account, the organization and the ADMIN membership:

```bash
curl -i -X POST http://localhost:3000/api/auth/register -H "Content-Type: application/json" \
  -d '{"name":"Me","email":"me@example.com","password":"change-me-123","organizationName":"My Store"}'
```

The organization id is a slug of the name (`my-store`). The admin invites agents from the Team screen (`POST /api/v1/invitations`).

## Demo accounts

After `npm run seed:demo`. Organization `acme-store`, password `Passw0rd!123` for every staff account.

| Role | Email |
|---|---|
| ADMIN | `admin@acme-store.example` |
| AGENT | `wanjiru@acme-store.example`, `otieno@acme-store.example` |

Customers are contacts, not accounts. These are public demo credentials: never seed them into a database real businesses use.

## How it works

- **Auth:** a business owner registers (`POST /api/auth/register`); staff join by invitation. `POST /api/auth/sign-in/email` returns the session token in the `set-auth-token` header. Send it as `Authorization: Bearer <token>`.
- **Organizations:** an account can belong to several organizations (stored as `tenants`), with a role in each (`ADMIN` or `AGENT`, table `organization_members`). Organization-scoped requests send `X-Organization-Id`; the API checks for an active membership on every request, so deactivation takes effect at once. Every query is scoped by organization; another organization's data returns 404.
- **Contacts:** customers are organization-scoped contacts without accounts. Staff record tickets for them, and can share a secure tracking link (no login) where the customer sees public replies and answers.
- **Tickets:** numbered per organization; status flow `OPEN → IN_PROGRESS ⇄ WAITING_ON_CUSTOMER → RESOLVED → CLOSED` (resolved tickets can be reopened), validated on the server. Updates are atomic, row-locked, and take an optional `version` (stale → 409).
- **Audit:** each change writes an audit row in the same transaction.

Routes: `/api/auth/*` (Better Auth), `/api/v1/*` (business API), `/health`.

## Project structure

```
src/
  auth/         auth.ts (Better Auth setup), plugin.ts (requireAuth, verifyRole), roles, auth-user
  config/       env, db, constants
  model/        enums, schema (Drizzle)
  dto/          zod request schemas
  repository/   queries, always scoped by tenant
  service/      business rules, policy, notifications, storage (local, Cloudinary)
  controller/   routes
  exception/    typed errors mapped to HTTP status
  app.ts        wiring: CORS, error handler, services, /api/v1 prefix
  server.ts     entry point
scripts/        seed.ts, seed-demo.ts
test/           helpers.ts, ticket-system.test.ts, cloudinary.storage.test.ts
drizzle/        SQL migrations
```

Request flow: controller (validate, role guard) → service (rules, transaction, audit) → policy (ownership) → repository → Postgres.

## Deploy on Render

| Setting | Value |
|---|---|
| Root directory | `backend` (if the repo also holds the frontend) |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Health check path | `/health` |

Environment: `NODE_VERSION=22`, `NODE_ENV=production`, `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=https://<your-service>.onrender.com`, `TRUSTED_ORIGINS=https://<your-app>.vercel.app`, `APP_URL=https://<your-app>.vercel.app`, `TRUST_PROXY_HOPS=1`, `STORAGE_DRIVER=cloudinary` and the three `CLOUDINARY_*` values. Do not set `PORT`.

- `--include=dev` is needed because Render sets `NODE_ENV=production` and TypeScript is a dev dependency.
- Render's disk is wiped on every deploy, so production must use Cloudinary.
- Run migrations and seeds from your machine with the production `DATABASE_URL`.
- The free tier sleeps when idle. The first request after a pause can take up to a minute.
- Redeploy after changing `TRUSTED_ORIGINS`.

## Tests

```bash
npm test
```

Runs against an in-process Postgres with the real migrations, two organizations and the real auth flow. It covers registration, invitations, memberships and deactivation, organization isolation, contacts, the ticket workflow, concurrency (409), public and internal comments, tracking links (expiry, revocation, public data only), uploads, search and pagination, dashboard, audit entries, rate limiting, and the Cloudinary adapter (against a fake SDK). `test/migration.test.ts` applies the v1 → v2 data migration to first-version data and checks nothing is lost.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `relation "tenants" does not exist` | Migrations not applied to that database: `npm run db:migrate` |
| 502 from Render | The process is not running. Read the Render logs: a missing env var, a wrong start path, or still waking up. |
| 403 `Invalid origin` on sign-in | The frontend URL is not in `TRUSTED_ORIGINS` (exact scheme and host, no trailing slash). Redeploy. |
| Browser CORS error | Same cause. Preview deployments have different URLs, so add them or test on the main one. |
| "Invalid email or password" for a seeded user | The seed did not run against this `DATABASE_URL`: `npm run seed:demo` |
| 400 "Send the organization id in the X-Organization-Id header" | The client did not send `X-Organization-Id`. Get the ids from `GET /api/v1/organizations`. |
| 403 "not an active member of this organization" | Wrong organization id, or the member was deactivated. |
| Tests fail with `Cannot read properties of undefined (reading 'config')` | Windows: run them from a path with an uppercase drive letter (`D:\...`, not `d:\...`). |
| 500 on file upload | See the Render log line after `unhandled error`. Usually wrong `CLOUDINARY_*` values, or `STORAGE_DRIVER=local` on Render. |
| Tests cannot find tables | No migration in `drizzle/`: `npm run db:generate -- --name init` |

## Not built yet

WhatsApp, Instagram and email channels, agent-logged tickets with a tracking link, saved replies, a real email provider (notifications are only logged), change and reset password, deactivating users, SLA timers, rate limiting.