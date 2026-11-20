# Requirements

**Product:** a multi-tenant support desk. Businesses track customer problems (inquiries, IT requests, internal issues) as structured tickets with owners, status and history.

## Actors

| Actor | Can |
|---|---|
| Customer | Create tickets, see and reply to their own, attach files |
| Agent | See all tickets of the store, pick up and work assigned ones, reply, attach |
| Admin | Everything an agent can, plus assign and reassign, manage the team, read the audit log |

## Functional

| Requirement (from the design) | Status |
|---|---|
| Create a ticket (title, description, type, priority) | Done |
| View ticket details and status | Done |
| Assign agents | Done |
| Comments from users and agents | Done |
| Status updates: Open, In progress, Resolved, Closed | Done, with validated transitions |
| Attach files (screenshots, logs, PDFs) | Done |
| Search and filter (status, priority, type, assignee, text) | Done, with pagination and sorting |
| Notify on assignment, status change, new comment | Partial: events are logged, no email provider yet |

**Added beyond the original design:** multi-tenancy (one store per tenant), ticket types, audit log, team management (admins create agents), unassigned filter and sort by priority, optimistic locking.

## Non-functional

| Requirement | How it is met |
|---|---|
| Scalable | Tenant-first indexes, pagination everywhere |
| Consistent, no data loss | Transactions, row locks, version check, audit written in the same transaction |
| Low latency | Indexed queries. The free Render tier adds a cold start after idle. |
| Secure access by role | Better Auth sessions, role hooks per route, ownership rules per ticket |
| Tenant isolation | Every query is scoped by tenant. Other tenants' data returns 404. |
| Audit logs | `audit_logs` table, admin-only screen |
| Secure file storage | Cloudinary authenticated assets, no public URLs, type and content checks |
| Modular, easy to extend | Controller, service and repository layers, one module per feature |
| High availability | Not met: single instance |

## Not built yet

- WhatsApp, Instagram and email channels
- Agent-logged tickets with a channel and customer contact, plus a customer tracking link
- Saved replies
- A real email provider
- Change and reset password
- Deactivating users
- SLA timers
- Custom fields
- Billing
- Rate limiting
- Frontend tests

## Compliance

Kenya's Data Protection Act applies: the operator must register with the ODPC as a data processor. Confirm exemptions with a lawyer before launch.