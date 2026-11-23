# API

| | |
|---|---|
| Production | `https://ticket-system-wkx3.onrender.com` |
| Local | `http://localhost:3000` |
| Auth routes | `/api/auth/*` (Better Auth) and `POST /api/auth/register` |
| Business routes | `/api/v1/*` |
| Public routes | `/api/v1/public/*` (no login: tracking links, invitations) |
| Health | `GET /health` |

## How it works

1. A business owner **registers** (`POST /api/auth/register`). That creates their account, the organization, and their `ADMIN` membership. Staff join through **invitations**.
2. **Sign in** → the response header `set-auth-token` holds the session token. Send it on every request: `Authorization: Bearer <token>`.
3. `GET /api/v1/organizations` lists the organizations the user belongs to. The client picks one and sends its id on **every organization-scoped request**: `X-Organization-Id: <id>`. The API checks for an **active** membership on every request (no header → 400, not an active member → 403).
4. Roles are per organization: `ADMIN` or `AGENT`. One account can be an admin in one organization and an agent in another.
5. Customers do **not** have accounts. They are **contacts** of an organization. Staff record tickets for them and can share a **tracking link** that needs no login.
6. Another organization's data returns `404`, as if it did not exist.

```bash
curl -i -X POST $API/api/auth/sign-in/email -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"..."}'          # token in set-auth-token
curl $API/api/v1/organizations -H "Authorization: Bearer <token>"
curl $API/api/v1/tickets -H "Authorization: Bearer <token>" -H "X-Organization-Id: acme-store"
```

## Conventions

- **Lists** return `{ items, page, pageSize, total, totalPages }`. `pageSize` defaults to 20, max 100.
- **Errors** (our routes): `{ "error": { "code", "message", "details?" } }`. Better Auth routes return `{ "code", "message" }`.
- **Ids:** tickets, contacts, comments, attachments and invitations are numbers; users and organizations are strings. Organization ids are slugs (`acme-store`).
- **Dates:** ISO 8601 strings.
- **Field names kept from v1:** `title` is the ticket subject, `assigneeId` the assigned agent, comment `text` the body.

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Invalid input (`details` lists fields), or missing `X-Organization-Id` |
| 401 | `UNAUTHORIZED` | Missing or expired token |
| 403 | `FORBIDDEN`, `SIGN_UP_DISABLED` | Role or ownership not allowed, not an active member |
| 404 | `NOT_FOUND`, `TRACKING_LINK_INVALID`, `INVITATION_INVALID` | Missing, belongs to another organization, or the token is invalid / expired / revoked |
| 409 | `CONFLICT`, `EMAIL_TAKEN`, `VERSION_CONFLICT`, `INVALID_STATUS_TRANSITION`, `TICKET_CLOSED`, `TOO_MANY_ATTACHMENTS`, `CONTACT_EXISTS`, `ALREADY_MEMBER`, `ACCOUNT_EXISTS`, `LAST_ADMIN`, `INVITATION_NOT_PENDING` | State conflicts |
| 413 | `FILE_TOO_LARGE` | Upload over the size limit |
| 415 | `UNSUPPORTED_FILE_TYPE` | Type, extension or content not allowed |
| 429 | `RATE_LIMITED` | Too many requests on a public route |

## Auth

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/auth/register` | `name, email, password (8–128), organizationName` | 201 `{ user, organization: { id, name, logo, role: 'ADMIN' } }` and `set-auth-token`. Duplicate email → 409 `EMAIL_TAKEN`. |
| POST | `/api/auth/sign-in/email` | `email, password` | 200 and `set-auth-token`. Wrong credentials → 401. |
| GET | `/api/auth/get-session` | none | `{ session, user }` or `null` |
| POST | `/api/auth/sign-out` | none | Revokes the session |
| POST | `/api/auth/sign-up/*` | | **Disabled** (403 `SIGN_UP_DISABLED`). Use register or an invitation. |

## Organizations (`/api/v1`)

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/organizations` | signed in (no org header) | `[{ id, name, logo, role, joinedAt }]`, active memberships only |
| GET | `/organizations/current` | ADMIN, AGENT | `{ id, name, logo, createdAt, role }` |
| PATCH | `/organizations/current` | ADMIN | `{ name?, logo? (https URL or null) }` |
| GET | `/dashboard/overview` | ADMIN, AGENT | `{ totals: { total, OPEN, IN_PROGRESS, WAITING_ON_CUSTOMER, RESOLVED, CLOSED }, assigned: { mine, unassigned, byAssignee: [{ userId, name, open }] }, recentTickets }` |

## Team: members and invitations

`/users` is the organization's team: its members with their role and status **in this organization**.

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/users?role=&status=&page=&pageSize=` | ADMIN, AGENT | Members: `userId, tenantId, name, email, role, status, emailVerified, createdAt, updatedAt` |
| GET | `/users/:id` | ADMIN, AGENT | One member |
| POST | `/users` | ADMIN | Create a staff account directly: `{ name, email, password, role }` → 201 |
| PATCH | `/users/:id` | ADMIN | `{ role?, status?: 'ACTIVE' \| 'DEACTIVATED' }`. A deactivated member loses access at their next request. The last active admin can't be demoted or deactivated (409 `LAST_ADMIN`). |
| GET | `/invitations` | ADMIN | `status`: `PENDING`, `ACCEPTED`, `REVOKED` or `EXPIRED` |
| POST | `/invitations` | ADMIN | `{ email, role? = 'AGENT' }` → 201 `{ invitation, token, path, url }`. **The token is shown only here.** Re-inviting an email replaces its pending invitation. The invitee is also e-mailed the link. |
| POST | `/invitations/:id/revoke` | ADMIN | 204 |
| GET | `/public/invitations/:token` | public | `{ organization: { name, logo }, email, role, expiresAt, accountExists }` |
| POST | `/public/invitations/:token/accept` | public | Without an account: `{ name, password }` → creates it with the invited email and signs it in (`set-auth-token`). With an account: send its `Authorization` header (the account email must match) and no body. → `{ organization: { id, name, logo, role } }` |

## Contacts

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/contacts?q=&page=&pageSize=` | ADMIN, AGENT | Search name, phone or email, newest first |
| POST | `/contacts` | ADMIN, AGENT | `{ name, phone, email? }` → 201. The phone is normalised (spaces, dashes, dots and brackets removed). A phone that already exists in the organization → 409 `CONTACT_EXISTS` with `details: { contactId, name }`, so the existing contact can be reused. |
| GET | `/contacts/:id` | ADMIN, AGENT | One contact |
| GET | `/contacts/:id/tickets` | ADMIN, AGENT | The contact's ticket history, newest first |

Contact fields: `contactId, tenantId, name, phone, email, userId (legacy), createdAt, updatedAt`.

## Tickets

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/tickets` | ADMIN, AGENT | Create (below) → 201 |
| GET | `/tickets` | ADMIN, AGENT | The organization's queue, with filters |
| GET | `/tickets/search?q=` | ADMIN, AGENT | Search title, description, order reference, contact name / phone, ticket number (`42` or `#42`), plus the same filters |
| GET | `/tickets/my` | ADMIN, AGENT | Assigned to me |
| GET | `/tickets/:id` | ADMIN, AGENT | Detail |
| PATCH | `/tickets/:id` | ADMIN, AGENT | Update (below) |

**Create:** `{ contactId }` **or** `{ contact: { name, phone, email? } }`, plus `title, description, channel, type?, priority?, orderRef?, assigneeId?`. A new contact whose phone already exists is reused, not duplicated. `ticketNumber` is sequential per organization.

**Ticket fields:** `ticketId, ticketNumber, tenantId, contactId, title, description, type, priority, status, channel, orderRef, assigneeId, createdBy, requesterId (legacy), version, resolvedAt, closedAt, createdAt, updatedAt`, plus `contactName, contactPhone, contactEmail, assigneeName, createdByName`.

**Enums:**
- `type`: `ORDER_ISSUE`, `DELIVERY`, `PAYMENT`, `RETURN_REFUND`, `PRODUCT_INQUIRY`, `COMPLAINT`, `OTHER` (default)
- `priority`: `LOW`, `NORMAL` (default), `HIGH`, `URGENT`
- `status`: `OPEN`, `IN_PROGRESS`, `WAITING_ON_CUSTOMER`, `RESOLVED`, `CLOSED`
- `channel`: `WHATSAPP`, `INSTAGRAM`, `TIKTOK`, `PHONE`, `EMAIL`, `WEBSITE`, `WALK_IN`, `OTHER`. Recorded only: there is no integration with these channels.

**List filters:** `status, priority, type, channel, assigneeId, unassigned=true, contactId, requesterId (legacy), sortBy (createdAt | updatedAt | priority), order (asc | desc), page, pageSize`.

### Updating a ticket (`PATCH`)

Body: any of `status, priority, type, channel, assigneeId (string | null), title, description, orderRef`, plus optional `version`. All changes apply atomically.

| Rule | Detail |
|---|---|
| Status flow | `OPEN → IN_PROGRESS / WAITING_ON_CUSTOMER / RESOLVED`; `IN_PROGRESS ⇄ WAITING_ON_CUSTOMER`, both `→ RESOLVED`; `RESOLVED → CLOSED` or reopen to `IN_PROGRESS`. `CLOSED` is final (409 `INVALID_STATUS_TRANSITION`, then `TICKET_CLOSED`). `resolvedAt` / `closedAt` are set automatically (reopening clears `resolvedAt`). |
| Who may change | Admins; the assignee; anyone while the ticket is unassigned. |
| Assignment | The assignee must be an **active member** (agent or admin) of the organization. Agents assign unassigned tickets and hand over their own; reassigning another agent's ticket is admin-only. `IN_PROGRESS` and `WAITING_ON_CUSTOMER` tickets must stay assigned. An agent moving an unassigned ticket to one of those statuses takes it; an admin must assign someone first (400). |
| **Concurrency** | Send the `version` you last read. A stale one → 409 `VERSION_CONFLICT` and nothing is saved. |

## Comments

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/tickets/:id/comments` | ADMIN, AGENT | `{ text (1–5000), visibility: 'PUBLIC' \| 'INTERNAL' }` (**required**) → 201. `PUBLIC` is shown on the tracking page, `INTERNAL` never is. Closed ticket → 409. |
| GET | `/tickets/:id/comments` | ADMIN, AGENT | Both visibilities, oldest first, paginated |
| DELETE | `/comments/:id` | author, ADMIN | 204 |

Comment fields: `commentId, ticketId, authorId, authorContactId, authorType ('STAFF' | 'CONTACT'), authorName, authorRole ('ADMIN' | 'AGENT' | 'CUSTOMER'), text, visibility, createdAt, updatedAt`. A customer reply through the tracking link has `authorType: 'CONTACT'` and `authorId: null`.

## Attachments

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/tickets/:id/attachments?visibility=&commentId=` | ADMIN, AGENT | `multipart/form-data`, field `file` → 201. `visibility` defaults to `INTERNAL`. With `commentId` the attachment takes that comment's visibility. |
| GET | `/tickets/:id/attachments` | ADMIN, AGENT | Array of metadata |
| GET | `/attachments/:id` | ADMIN, AGENT | One attachment's metadata |
| GET | `/attachments/:id/download` | ADMIN, AGENT | The file (fetch it as a blob with the headers) |
| DELETE | `/attachments/:id` | uploader, ADMIN | 204 |

**Limits:** 5 MB per file, 10 files per ticket, no uploads to closed tickets. Allowed: PNG, JPG, WebP, GIF, PDF, TXT, LOG. The content must match the type.

Attachment fields: `attachmentId, ticketId, commentId, fileName, fileType, visibility, uploadedBy, createdAt, url`. The storage location is never returned.

## Customer tracking links

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/tickets/:id/tracking-link` | ADMIN, AGENT | → 201 `{ token, path: '/track/<token>', url, expiresAt }`. **The token is shown only here.** Creating a link revokes the previous one (one active link per ticket). |
| GET | `/tickets/:id/tracking-link` | ADMIN, AGENT | `{ active, expiresAt, createdAt }` |
| POST | `/tickets/:id/tracking-link/revoke` | ADMIN, AGENT | 204 |
| GET | `/public/tickets/:token` | public | `{ ticket: { ticketNumber, title, description, status, type, orderRef, createdAt, updatedAt, resolvedAt, closedAt }, organization: { name, logo }, contact: { name }, comments: [{ commentId, text, authorType, authorName, createdAt }], attachments: [{ attachmentId, fileName, fileType, createdAt }], canReply, linkExpiresAt }`. Public comments and attachments only. |
| POST | `/public/tickets/:token/comments` | public | `{ text }` → 201. Always public. A reply to a `WAITING_ON_CUSTOMER` or `RESOLVED` ticket moves it back to `IN_PROGRESS` (or `OPEN` if nobody is assigned). Closed → 409. Not forwarded to WhatsApp, Instagram or any other channel. |
| GET | `/public/tickets/:token/attachments/:attachmentId` | public | A public attachment of that ticket |

Security: tokens are 256-bit random values; only their SHA-256 is stored. Unknown, malformed, expired (default 30 days) and revoked tokens all get the same `404 TRACKING_LINK_INVALID`. Public routes are rate limited per IP (60 reads, 10 writes a minute) and sent with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`. Tokens are removed from logged URLs.

## Audit log

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/audit-logs?entityType=&entityId=&actorId=&action=&page=&pageSize=` | ADMIN | Who did what and when, newest first. `actorId` gives one staff member's activity. |

Each entry has `actorName`, `actorRole` (role in this organization, `null` for customers and system actions), `action`, `entityType` (`TICKET`, `USER`, `CONTACT`, `INVITATION`, `ORGANIZATION`), `entityId`, `metadata`, `createdAt`.

**Actions:** `TICKET_CREATED, TICKET_ASSIGNED, TICKET_STATUS_CHANGED, TICKET_PRIORITY_CHANGED, TICKET_TYPE_CHANGED, TICKET_UPDATED, COMMENT_ADDED, COMMENT_DELETED, ATTACHMENT_ADDED, ATTACHMENT_DELETED, TRACKING_LINK_CREATED, TRACKING_LINK_REVOKED, CONTACT_CREATED, USER_CREATED, MEMBER_ROLE_CHANGED, MEMBER_DEACTIVATED, MEMBER_REACTIVATED, INVITATION_CREATED, INVITATION_REVOKED, INVITATION_ACCEPTED, ORGANIZATION_CREATED, ORGANIZATION_UPDATED`, plus `TICKET_TYPE_MIGRATED` (written once by the v1 → v2 data migration, keeping each ticket's original type).

## Notifications

Sent after a change commits and never block a request. Only **logged** for now (no email provider). Recipients are active members of the organization, never the person who acted. Customers are not e-mailed.

| Event | Recipients |
|---|---|
| New ticket | The organization's agents |
| Assignment | The new assignee, the previous assignee |
| Status change | The assignee |
| Comment / customer reply | The assignee (the agents, for a customer reply on an unassigned ticket) |
| Invitation | The invited email (contains the link) |
