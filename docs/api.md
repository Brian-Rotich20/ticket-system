# API

| | |
|---|---|
| Production | `https://ticket-system-wkx3.onrender.com` |
| Local | `http://localhost:3000` |
| Auth routes | `/api/auth/*` (Better Auth) |
| Business routes | `/api/v1/*` |
| Health | `GET /health` |

## How it works

1. **Sign in** → the response header `set-auth-token` holds the session token.
2. **Send it** on every request: `Authorization: Bearer <token>`.
3. Every user belongs to **one tenant** (a store). All data is scoped to it. Data from another tenant returns `404`, as if it did not exist.
4. **Roles** (`CUSTOMER`, `AGENT`, `ADMIN`) are checked per route, then per ticket (ownership, assignment).

```bash
# 1. sign in, read the token from the set-auth-token header
curl -i -X POST $API/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@acme-store.example","password":"Passw0rd!123"}'

# 2. use it
curl $API/api/v1/tickets -H "Authorization: Bearer <token>"
```

## Conventions

- **Lists** return `{ items, page, pageSize, total, totalPages }`. `pageSize` defaults to 20, max 100.
- **Errors** (our routes): `{ "error": { "code", "message", "details?" } }`. Auth routes return `{ "code", "message" }`.
- **Ids:** tickets, comments and attachments are numbers. Users are strings.
- **Dates:** ISO 8601 strings.

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Invalid input (`details` lists fields) |
| 401 | `UNAUTHORIZED` | Missing or expired token |
| 403 | `FORBIDDEN` | Role or ownership not allowed |
| 404 | `NOT_FOUND` | Missing, or belongs to another tenant |
| 409 | `CONFLICT`, `EMAIL_TAKEN`, `VERSION_CONFLICT`, `INVALID_STATUS_TRANSITION`, `TICKET_CLOSED`, `TOO_MANY_ATTACHMENTS` | State conflicts |
| 413 | `FILE_TOO_LARGE` | Upload over the size limit |
| 415 | `UNSUPPORTED_FILE_TYPE` | Type, extension or content not allowed |

## Auth (`/api/auth`)

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/sign-up/email` | `name, email, password (8–128), tenantId` | 200, user and `set-auth-token`. Always a `CUSTOMER` (`role` is ignored). `tenantId` must exist. Duplicate email → 422. |
| POST | `/sign-in/email` | `email, password` | 200 and `set-auth-token`. Wrong credentials → 401. |
| GET | `/get-session` | none | `{ session, user }` (user has `tenantId`, `role`), or `null` |
| POST | `/sign-out` | none | Revokes the session |

## Public

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/public/tenants/:slug` | Store name for the sign-up page → `{ id, name }` |
| GET | `/health` | `{ "status": "ok" }` |

## Users

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/v1/users?role=&page=&pageSize=` | AGENT, ADMIN | List users in the tenant |
| GET | `/api/v1/users/:id` | any | One user. Customers may only fetch themselves (403 otherwise). |
| POST | `/api/v1/users` | ADMIN | Create a user: `{ name, email, password, role }` → 201. Role is raised server-side. |

## Tickets

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/api/v1/tickets` | any | Create: `{ title, description, type?, priority? }` → 201 |
| GET | `/api/v1/tickets` | any | List and filter (below). Customers see only their own. |
| GET | `/api/v1/tickets/search?q=` | any | Search title and description, plus the same filters |
| GET | `/api/v1/tickets/my` | any | Assigned to me (staff) or raised by me (customer) |
| GET | `/api/v1/tickets/:id` | owner, staff | Detail |
| PATCH | `/api/v1/tickets/:id` | AGENT, ADMIN | Update (below) |

**Ticket fields:** `ticketId, tenantId, title, description, type, status, priority, requesterId, assigneeId, version, createdAt, updatedAt`. List, detail and PATCH responses also include `requesterName` and `assigneeName`.

**Enums:**
- `type`: `INQUIRY` (default), `IT_REQUEST`, `INTERNAL_ISSUE`
- `status`: `OPEN`, `IN_PROGRESS`, `RESOLVED`, `CLOSED`
- `priority`: `LOW`, `MEDIUM` (default), `HIGH`, `URGENT`

**List filters:** `status, priority, type, assigneeId, unassigned=true, requesterId, sortBy (createdAt | updatedAt | priority), order (asc | desc), page, pageSize`. `unassigned` wins over `assigneeId`. Sorting by `priority` desc puts urgent first.

### Updating a ticket (`PATCH`)

Body: any of `status, priority, type, assigneeId (string | null)`, plus optional `version`. All changes apply atomically.

| Rule | Detail |
|---|---|
| Status flow | `OPEN → IN_PROGRESS → RESOLVED → CLOSED`. Nothing else is allowed (for example `CLOSED → OPEN` → 409 `INVALID_STATUS_TRANSITION`). `CLOSED` is final. |
| Who may change | Admin, or the assigned agent. An unassigned ticket can be taken by an agent, and moving it to `IN_PROGRESS` self-assigns it. |
| Assignment | Assignees must be agents of the same tenant. Reassigning or unassigning is admin-only. An in-progress ticket cannot be left unassigned. |
| `IN_PROGRESS` as admin | The ticket needs an assignee first (400 otherwise). |
| Priority and type | Assigned agent or admin |
| **Concurrency** | Send the `version` you last read. A stale one → 409 `VERSION_CONFLICT` and nothing is saved. Without `version` the change is applied after a row lock. |

## Comments

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/api/v1/tickets/:id/comments` | owner, staff | `{ text (1–5000) }` → 201. A closed ticket → 409 `TICKET_CLOSED`. |
| GET | `/api/v1/tickets/:id/comments` | owner, staff | Oldest first, paginated |
| DELETE | `/api/v1/comments/:id` | author, ADMIN | 204 (the web app does not expose this) |

Comment fields: `commentId, ticketId, authorId, authorName, authorRole, text, createdAt`.

## Attachments

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/api/v1/tickets/:id/attachments` | owner, staff | `multipart/form-data`, field `file` → 201 |
| GET | `/api/v1/tickets/:id/attachments` | owner, staff | Array of metadata |
| GET | `/api/v1/attachments/:id` | owner, staff | One attachment's metadata |
| GET | `/api/v1/attachments/:id/download` | owner, staff | The file (needs the Bearer token, so fetch it as a blob) |
| DELETE | `/api/v1/attachments/:id` | uploader, ADMIN | 204 (not exposed in the web app) |

**Limits:** 5 MB per file, 10 files per ticket, no uploads to closed tickets. Allowed types: PNG, JPG, WebP, GIF, PDF, TXT, LOG. The file content must match its type.

Attachment fields: `attachmentId, ticketId, fileName, fileType, uploadedBy, createdAt, url`. The storage location is never returned.

## Audit log

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/v1/audit-logs?entityType=&entityId=&page=&pageSize=` | ADMIN | Who did what and when, newest first |

Each entry has `actorName`, `actorRole`, `action`, `entityType` (`TICKET` or `USER`), `entityId`, `metadata`, `createdAt`.

**Actions:** `TICKET_CREATED, TICKET_ASSIGNED, TICKET_STATUS_CHANGED, TICKET_PRIORITY_CHANGED, TICKET_TYPE_CHANGED, COMMENT_ADDED, COMMENT_DELETED, ATTACHMENT_ADDED, ATTACHMENT_DELETED, USER_CREATED`.

## Notifications

Triggered after a change commits, and never block a request. They are only **logged** for now (no email provider).

| Event | Recipients |
|---|---|
| New ticket | All agents of the tenant |
| Assignment | The new assignee, the requester, the previous assignee |
| Status change | Requester and assignee |
| New comment | The other participants |