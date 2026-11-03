# Customer Support Ticket System: backend (Phase 1)

Fastify + TypeScript + Drizzle ORM + PostgreSQL (Neon). Layered exactly as in the LLD:
`Controller -> Service -> Repository -> Database`, with Email and File Storage as external services.

```
src/
  model/        enums + Drizzle schema (User, Ticket, Comment, Attachment, AuditLog)
  repository/   data access only (TicketRepository, CommentRepository, ...)
  service/      business rules: Ticket / Comment / Attachment / Notification / User / Audit services, policy.ts (RBAC)
  controller/   HTTP routes, validation, delegation only
  dto/          zod request schemas
  exception/    AppError hierarchy -> HTTP status mapping
  config/       env + db
  auth/         JWT auth
drizzle/        SQL migrations
test/           integration tests (PGlite = real Postgres in-process, no DB needed)
```

## Run

```bash
cp .env.example .env            # set DATABASE_URL (Neon) and JWT_SECRET
npm install
npm run db:migrate              # applies drizzle/0000_init.sql
ADMIN_EMAIL=you@x.com ADMIN_PASSWORD='change-me-123' npm run seed:admin
npm run dev                     # http://localhost:3000
npm test                        # 11 integration tests
```

## API

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | /auth/register, /auth/login | public | sign up (CUSTOMER) / get JWT |
| POST | /tickets | any | create ticket |
| GET | /tickets | any | list + filter (status, priority, assigneeId, requesterId) + pagination + sort |
| GET | /tickets/search?q= | any | search title/description (+ same filters) |
| GET | /tickets/my | any | assigned to me (staff) / raised by me (customer) |
| GET | /tickets/:id | owner/staff | ticket details + status |
| PATCH | /tickets/:id | see rules | update status, priority, assigneeId (optional `version`) |
| POST/GET | /tickets/:id/comments | owner/staff | add / list comments |
| DELETE | /comments/:id | author/admin | delete comment |
| POST/GET | /tickets/:id/attachments | owner/staff | upload (multipart `file`) / list |
| GET | /attachments/:id, /attachments/:id/download | owner/staff | metadata+url / authorised download |
| DELETE | /attachments/:id | uploader/admin | delete |
| GET | /users, /users/:id | staff / self | list users (for assignment) / details |
| POST | /users | admin | create users with any role (onboard agents) |
| GET | /audit-logs | admin | who did what and when |

Errors: `{ "error": { "code", "message", "details?" } }` with 400/401/403/404/409/413/415.

## Permission rules (policy.ts)

- **Customer**: create tickets, see/comment/attach on own tickets only (others return 404), close own RESOLVED ticket.
- **Agent**: see all tickets; change status/priority only on tickets assigned to them; may self-assign an unassigned ticket (moving it to IN_PROGRESS self-assigns).
- **Admin**: everything, including re-assigning IN_PROGRESS tickets and creating agents.

## LLD requirement -> where it is implemented

| LLD requirement | Implementation |
|---|---|
| Create / view tickets | `TicketService.createTicket / getTicketById` |
| Assign agents | `assignTicket` (PATCH `assigneeId`); assignee must exist and be an AGENT |
| Comments | `CommentService` |
| Status Open -> In Progress -> Resolved -> Closed | `ALLOWED_TRANSITIONS` in `model/enums.ts`, enforced in `TicketService.mutate` |
| Attach files | `AttachmentService` + `StorageService` (local disk now, S3 later) |
| Search and filter | `/tickets`, `/tickets/search`, indexed columns, pagination |
| Notifications (assignment, status change, new comment) | `NotificationService` -> `EmailSender` (logs for now), fire-and-forget after commit |
| Consistency / no data loss | transactions; `SELECT ... FOR UPDATE` row lock + `version` column; audit row in same transaction |
| Low latency / scalable | indexes on status, assignee_id, requester_id, created_at; pagination everywhere |
| RBAC | JWT + `policy.ts` |
| Audit logs | `audit_logs` table, `/audit-logs` |
| Secure file storage | type allowlist + magic-byte check, size limit, filename sanitising, per-ticket cap, no public URLs (authorised download), `FileScanner` hook for antivirus |
| Edge cases | not found, invalid transition (CLOSED -> OPEN), large upload (413), concurrent updates (409), agent re-assignment while IN_PROGRESS (admin only), many comments/attachments |

## Decisions that go beyond the LLD (all small, all deliberate)

1. `users.password_hash` and `/auth/*`: the LLD needs RBAC but shows no login.
2. `tickets.version`: optimistic-lock counter for the "concurrent updates" edge case.
3. `audit_logs` table: the LLD lists audit logs as a requirement but not a schema.
4. Comments/attachments are blocked on CLOSED tickets (closed = terminal).
5. Status flow is strictly linear as drawn (no RESOLVED -> IN_PROGRESS reopen); add one line to `ALLOWED_TRANSITIONS` if you want it.
6. `attachments.file_url` stores the storage key; the real download URL is computed at read time.

## Not done yet (deliberately)

WhatsApp channel, real email provider, S3 storage, rate limiting on `/auth/*`, CORS (add `@fastify/cors` when the frontend exists), refresh tokens.
