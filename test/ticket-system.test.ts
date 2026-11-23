import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactUrl } from '../src/app.js';
import * as schema from '../src/model/schema.js';
import { hashToken } from '../src/service/secure-token.js';
import { createTestApp, type Session } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

describe('Customer Support Ticketing SaaS (multi-organization)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: Session; // Acme Store owner
  let globexAdmin: Session;
  let agent1: Session; // acme agents
  let agent2: Session;
  let globexAgent: Session;
  let contactId: number; // Amina, an acme customer contact
  let ticketId: number; // the main ticket
  let trackingToken: string;

  const ticketBody = (extra: object = {}) => ({
    title: 'Where is my order #1042?',
    description: 'Ordered 5 days ago via M-Pesa, tracking has not moved.',
    channel: 'WHATSAPP',
    type: 'DELIVERY',
    ...extra,
  });

  beforeAll(async () => {
    t = await createTestApp();
    ({ admin, globexAdmin } = t);
    agent1 = await t.api.addMember(admin, 'Agent One', 'agent1@acme.com');
    agent2 = await t.api.addMember(admin, 'Agent Two', 'agent2@acme.com');
    globexAgent = await t.api.addMember(globexAdmin, 'Globex Agent', 'agent@globex.com');
  });
  afterAll(() => t.close());

  // ---------------------------------------------------------------- registration and auth
  it('registration: creates the account, the organization and an ADMIN membership; signs the owner in', async () => {
    expect(admin.orgId).toBe('acme-store');
    const orgs = await t.api.call('GET', '/organizations', { token: admin.token, userId: admin.userId });
    expect(orgs.status).toBe(200);
    expect(orgs.body).toEqual([expect.objectContaining({ id: 'acme-store', name: 'Acme Store', role: 'ADMIN' })]);

    const current = await t.api.call('GET', '/organizations/current', admin);
    expect(current.body).toMatchObject({ id: 'acme-store', name: 'Acme Store', role: 'ADMIN' });

    // same business name twice -> a different slug, never a clash
    const other = await t.api.register('Other Owner', 'other@acme2.com', 'Acme Store');
    expect(other.orgId).toBe('acme-store-2');

    const reg = (body: object) => t.api.call('POST', '/api/auth/register', undefined, body);
    expect((await reg({ name: 'X', email: 'owner@acme.com', password: 'password123', organizationName: 'Dup' })).body.error.code).toBe('EMAIL_TAKEN');
    expect((await reg({ name: 'X', email: 'x@x.com', password: 'short', organizationName: 'Shop' })).status).toBe(400);
    expect((await reg({ name: 'X', email: 'x@x.com', password: 'password123' })).status).toBe(400); // no business name
    // a failed registration leaves no account behind
    expect(await t.db.select().from(schema.users).where(eq(schema.users.email, 'x@x.com'))).toHaveLength(0);
  });

  it('auth: customer self sign-up is disabled; protected routes need a session and an active membership', async () => {
    const signUp = await t.api.call('POST', '/api/auth/sign-up/email', undefined, { name: 'M', email: 'm@x.com', password: 'password123' });
    expect(signUp.status).toBe(403);

    expect((await t.api.call('GET', '/tickets')).status).toBe(401);
    expect((await t.api.call('GET', '/tickets', 'not-a-real-token')).status).toBe(401);
    expect((await t.api.call('GET', '/tickets', { token: admin.token, userId: admin.userId })).status).toBe(400); // no org header
    expect((await t.api.call('GET', '/tickets', { ...admin, orgId: 'globex-shop' })).status).toBe(403); // not a member there
    expect((await t.api.call('GET', '/tickets', admin)).status).toBe(200);

    // Better Auth's update-user can no longer move anyone between organizations (there is no tenant on the account)
    await t.api.call('POST', '/api/auth/update-user', agent1, { tenantId: 'globex-shop', role: 'ADMIN' });
    expect((await t.api.call('GET', '/tickets', { ...agent1, orgId: 'globex-shop' })).status).toBe(403);
    expect((await t.api.call('POST', '/invitations', agent1, { email: 'z@z.com' })).status).toBe(403); // still an agent
  });

  // ---------------------------------------------------------------- invitations and membership
  it('invitations: admin-only; accept creates the account; tokens are single-use, revocable and expire; hashes only', async () => {
    expect((await t.api.call('POST', '/invitations', agent1, { email: 'new@acme.com' })).status).toBe(403);

    const created = await t.api.call('POST', '/invitations', admin, { email: 'New@Acme.com' });
    expect(created.status).toBe(201);
    expect(created.raw.headers['cache-control']).toBe('no-store');
    expect(created.body).toMatchObject({ invitation: { email: 'new@acme.com', role: 'AGENT', status: 'PENDING' } });
    expect(created.body.url).toBe(`https://app.example.test/accept-invitation/${created.body.token}`);
    const [row] = await t.db.select().from(schema.invitations).where(eq(schema.invitations.invitationId, created.body.invitation.invitationId));
    expect(row!.tokenHash).toBe(hashToken(created.body.token)); // raw token never stored
    expect(row!.tokenHash).not.toContain(created.body.token);
    await t.services.notifier.flush();
    expect(t.email.sent.some((m) => m.to.includes('new@acme.com') && m.text.includes(created.body.token))).toBe(true);

    const info = await t.api.call('GET', `/public/invitations/${created.body.token}`);
    expect(info.body).toMatchObject({ organization: { name: 'Acme Store' }, email: 'new@acme.com', role: 'AGENT', accountExists: false });

    // re-inviting replaces the pending invitation
    const again = await t.api.call('POST', '/invitations', admin, { email: 'new@acme.com' });
    expect((await t.api.call('GET', `/public/invitations/${created.body.token}`)).status).toBe(404);
    expect((await t.api.call('POST', `/public/invitations/${again.body.token}/accept`, undefined, {})).status).toBe(400); // needs name + password
    const accepted = await t.api.call('POST', `/public/invitations/${again.body.token}/accept`, undefined, { name: 'New Agent', password: 'password123' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.organization).toMatchObject({ id: 'acme-store', role: 'AGENT' });
    expect(accepted.raw.headers['set-auth-token']).toBeTruthy();
    expect((await t.api.call('POST', `/public/invitations/${again.body.token}/accept`, undefined, { name: 'X', password: 'password123' })).status).toBe(404); // single use

    // already a member
    expect((await t.api.call('POST', '/invitations', admin, { email: 'agent1@acme.com' })).body.error.code).toBe('ALREADY_MEMBER');

    // revoke
    const revocable = await t.api.call('POST', '/invitations', admin, { email: 'revoke@acme.com' });
    expect((await t.api.call('POST', `/invitations/${revocable.body.invitation.invitationId}/revoke`, admin)).status).toBe(204);
    expect((await t.api.call('POST', `/public/invitations/${revocable.body.token}/accept`, undefined, { name: 'R', password: 'password123' })).status).toBe(404);

    // expired
    const old = await t.api.call('POST', '/invitations', admin, { email: 'late@acme.com' });
    await t.db.update(schema.invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invitations.invitationId, old.body.invitation.invitationId));
    expect((await t.api.call('GET', `/public/invitations/${old.body.token}`)).status).toBe(404);
    const list = await t.api.call('GET', '/invitations?pageSize=100', admin);
    const statuses = list.body.items.map((i: any) => `${i.email}:${i.status}`);
    // the first invitation to new@acme.com was replaced by the second, which was accepted
    expect(statuses).toEqual(expect.arrayContaining(['new@acme.com:ACCEPTED', 'new@acme.com:REVOKED', 'revoke@acme.com:REVOKED', 'late@acme.com:EXPIRED']));
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash|token_hash/);

    expect((await t.api.call('GET', '/public/invitations/not-a-token')).status).toBe(404);
  });

  it('membership: one account in several organizations with different roles; accepting needs the invited e-mail', async () => {
    // globex invites acme's agent1 (who already has an account) as ADMIN
    const token = await t.api.invite(globexAdmin, 'agent1@acme.com', 'ADMIN');
    expect((await t.api.call('GET', `/public/invitations/${token}`)).body.accountExists).toBe(true);
    expect((await t.api.call('POST', `/public/invitations/${token}/accept`, undefined, { name: 'X', password: 'password123' })).body.error.code).toBe('ACCOUNT_EXISTS');
    expect((await t.api.call('POST', `/public/invitations/${token}/accept`, { token: agent2.token, userId: agent2.userId })).status).toBe(403); // other e-mail
    expect((await t.api.call('POST', `/public/invitations/${token}/accept`, { token: agent1.token, userId: agent1.userId })).status).toBe(200);

    const orgs = await t.api.call('GET', '/organizations', { token: agent1.token, userId: agent1.userId });
    expect(orgs.body.map((o: any) => [o.id, o.role]).sort()).toEqual([['acme-store', 'AGENT'], ['globex-shop', 'ADMIN']]);
    // the role is per organization
    expect((await t.api.call('GET', '/audit-logs', agent1)).status).toBe(403);
    expect((await t.api.call('GET', '/audit-logs', { ...agent1, orgId: 'globex-shop' })).status).toBe(200);
  });

  it('team: admins deactivate members (access ends at once), cannot remove the last admin', async () => {
    const temp = await t.api.addMember(admin, 'Temp Agent', 'temp@acme.com');
    expect((await t.api.call('GET', '/tickets', temp)).status).toBe(200);
    expect((await t.api.call('PATCH', `/users/${temp.userId}`, agent1, { status: 'DEACTIVATED' })).status).toBe(403);
    const off = await t.api.call('PATCH', `/users/${temp.userId}`, admin, { status: 'DEACTIVATED' });
    expect(off.body).toMatchObject({ userId: temp.userId, status: 'DEACTIVATED' });
    expect((await t.api.call('GET', '/tickets', temp)).status).toBe(403); // same session, no access
    expect((await t.api.call('GET', '/organizations', { token: temp.token, userId: temp.userId })).body).toEqual([]);

    expect((await t.api.call('PATCH', `/users/${admin.userId}`, admin, { role: 'AGENT' })).body.error.code).toBe('LAST_ADMIN');
    expect((await t.api.call('PATCH', `/users/${admin.userId}`, admin, { status: 'DEACTIVATED' })).body.error.code).toBe('LAST_ADMIN');

    const team = await t.api.call('GET', '/users?pageSize=100', agent1);
    expect(team.body.items.every((u: any) => u.tenantId === 'acme-store')).toBe(true);
    expect(team.body.items.find((u: any) => u.userId === temp.userId).status).toBe('DEACTIVATED');
    expect(JSON.stringify(team.body)).not.toMatch(/password|hash/i);
  });

  it('organization profile: admin updates name and logo', async () => {
    expect((await t.api.call('PATCH', '/organizations/current', agent1, { name: 'Hacked' })).status).toBe(403);
    expect((await t.api.call('PATCH', '/organizations/current', admin, { logo: 'http://insecure.example/logo.png' })).status).toBe(400);
    const r = await t.api.call('PATCH', '/organizations/current', admin, { logo: 'https://cdn.example/acme.png' });
    expect(r.body).toMatchObject({ id: 'acme-store', name: 'Acme Store', logo: 'https://cdn.example/acme.png' });
  });

  // ---------------------------------------------------------------- contacts
  it('contacts: created, searched and reused per organization; phones are normalised and never globally unique', async () => {
    const c = await t.api.call('POST', '/contacts', agent1, { name: 'Amina Hassan', phone: '0712 345-678', email: 'amina@example.com' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: 'Amina Hassan', phone: '0712345678', email: 'amina@example.com', tenantId: 'acme-store' });
    contactId = c.body.contactId;

    const dup = await t.api.call('POST', '/contacts', agent2, { name: 'Amina H.', phone: '0712-345-678' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'CONTACT_EXISTS', details: { contactId } });

    // the same customer can be a contact of another business
    expect((await t.api.call('POST', '/contacts', globexAgent, { name: 'Amina', phone: '0712345678' })).status).toBe(201);

    expect((await t.api.call('POST', '/contacts', agent1, { name: 'No phone' })).status).toBe(400);
    expect((await t.api.call('POST', '/contacts', agent1, { name: 'Bad', phone: 'call me' })).status).toBe(400);

    expect((await t.api.call('GET', '/contacts?q=0712', agent1)).body.total).toBe(1);
    expect((await t.api.call('GET', '/contacts?q=amina', agent1)).body.items[0].contactId).toBe(contactId);
    expect((await t.api.call('GET', `/contacts/${contactId}`, globexAgent)).status).toBe(404);
    expect((await t.api.call('GET', `/contacts/${contactId}`, { ...globexAgent, orgId: 'acme-store' })).status).toBe(403);
  });

  // ---------------------------------------------------------------- tickets
  it('create ticket: for an existing contact, validates input, numbers per organization, notifies the other agents', async () => {
    expect((await t.api.call('POST', '/tickets', agent1, ticketBody({ contactId, title: '  ' }))).status).toBe(400);
    expect((await t.api.call('POST', '/tickets', agent1, ticketBody({ contactId, channel: undefined }))).status).toBe(400); // channel required
    expect((await t.api.call('POST', '/tickets', agent1, ticketBody({ contactId, priority: 'MEDIUM' }))).status).toBe(400); // old enum
    expect((await t.api.call('POST', '/tickets', agent1, ticketBody())).status).toBe(400); // no contact

    const r = await t.api.call('POST', '/tickets', agent1, ticketBody({ contactId, orderRef: 'ORD-1042' }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      ticketNumber: 1, tenantId: 'acme-store', contactId, contactName: 'Amina Hassan', contactPhone: '0712345678',
      status: 'OPEN', priority: 'NORMAL', type: 'DELIVERY', channel: 'WHATSAPP', orderRef: 'ORD-1042',
      createdBy: agent1.userId, createdByName: 'Agent One', assigneeId: null, requesterId: null, version: 1, resolvedAt: null,
    });
    ticketId = r.body.ticketId;

    await t.services.notifier.flush();
    const mail = t.email.sent.find((m) => m.subject.startsWith('[Ticket #1]') && m.subject.includes('New'));
    expect(mail?.to).toContain('agent2@acme.com');
    for (const notTold of ['agent1@acme.com', 'temp@acme.com', 'agent@globex.com']) expect(mail?.to).not.toContain(notTold); // creator, deactivated, other org

    // contact from another organization
    const foreign = (await t.api.call('GET', '/contacts?q=amina', globexAgent)).body.items[0].contactId;
    expect((await t.api.call('POST', '/tickets', agent1, ticketBody({ contactId: foreign }))).status).toBe(404);
  });

  it('create ticket: a new contact is created, or reused when its phone already exists; numbers are unique under concurrency', async () => {
    const reuse = await t.api.call('POST', '/tickets', agent2, ticketBody({ contact: { name: 'Amina again', phone: '+0712345678'.slice(1) }, type: 'PAYMENT' }));
    expect(reuse.body).toMatchObject({ contactId, ticketNumber: 2 }); // same phone -> same contact, no duplicate

    const fresh = await t.api.call('POST', '/tickets', agent2, ticketBody({ contact: { name: 'Kevin Mutua', phone: '+254 700 111 222' }, channel: 'PHONE' }));
    expect(fresh.body).toMatchObject({ contactName: 'Kevin Mutua', contactPhone: '+254700111222', ticketNumber: 3 });

    const many = await Promise.all(
      Array.from({ length: 5 }, (_, i) => t.api.call('POST', '/tickets', agent1, ticketBody({ contactId, title: `Parallel ${i}`, channel: 'INSTAGRAM' }))),
    );
    expect(many.map((m) => m.status)).toEqual([201, 201, 201, 201, 201]);
    expect(many.map((m) => m.body.ticketNumber).sort()).toEqual([4, 5, 6, 7, 8]);

    // numbering is per organization
    const g = await t.api.call('POST', '/tickets', globexAgent, ticketBody({ contact: { name: 'G', phone: '0799000000' } }));
    expect(g.body.ticketNumber).toBe(1);

    // the contact's ticket history
    const history = await t.api.call('GET', `/contacts/${contactId}/tickets?pageSize=100`, agent1);
    expect(history.body.total).toBe(7);
    expect((await t.api.call('GET', `/contacts/${contactId}/tickets`, globexAgent)).status).toBe(404);
  });

  it('assignment: agents take or hand over their own tickets; reassigning another agent\'s ticket is admin-only; assignee must be an active member', async () => {
    const r = await t.api.call('PATCH', `/tickets/${ticketId}`, agent1, { assigneeId: agent2.userId }); // unassigned -> agent2
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ assigneeId: agent2.userId, assigneeName: 'Agent Two', version: 2 });
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent1, { assigneeId: agent1.userId })).status).toBe(403); // agent2's now
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent2, { assigneeId: agent1.userId })).status).toBe(200); // hand-over
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, admin, { assigneeId: globexAgent.userId })).status).toBe(400); // other org
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, admin, { assigneeId: 'does-not-exist' })).status).toBe(400);
    const temp = (await t.api.call('GET', '/users?status=DEACTIVATED', admin)).body.items[0].userId;
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, admin, { assigneeId: temp })).status).toBe(400); // deactivated

    await t.services.notifier.flush();
    expect(t.email.sent.some((m) => m.to.includes('agent2@acme.com') && m.subject.includes('Assigned to Agent Two'))).toBe(true);
    expect(t.email.sent.some((m) => m.to.includes('agent1@acme.com') && m.subject.includes('Assigned to Agent One'))).toBe(true);
    // agent2 handed it over themselves, so they are not told about their own action
    expect(t.email.sent.some((m) => m.to.includes('agent2@acme.com') && m.text.includes('reassigned to Agent One'))).toBe(false);

    // assigning when creating, to an admin
    const created = await t.api.call('POST', '/tickets', agent1, ticketBody({ contactId, assigneeId: admin.userId }));
    expect(created.body.assigneeId).toBe(admin.userId);
  });

  it('workflow: validated transitions incl. WAITING_ON_CUSTOMER and reopen; resolution and closure dates; CLOSED is final', async () => {
    const cur = (await t.api.call('GET', `/tickets/${ticketId}`, agent1)).body; // assigned to agent1
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent2, { status: 'IN_PROGRESS' })).status).toBe(403); // not theirs
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent1, { status: 'CLOSED' })).body.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent1, { status: 'IN_PROGRESS', version: cur.version })).body.status).toBe('IN_PROGRESS');
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent1, { status: 'WAITING_ON_CUSTOMER' })).body.status).toBe('WAITING_ON_CUSTOMER');
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, admin, { assigneeId: null })).status).toBe(409); // must stay assigned

    const resolved = await t.api.call('PATCH', `/tickets/${ticketId}`, agent1, { status: 'RESOLVED' });
    expect(resolved.body.resolvedAt).not.toBeNull();
    const reopened = await t.api.call('PATCH', `/tickets/${ticketId}`, agent1, { status: 'IN_PROGRESS' }); // reopen
    expect(reopened.body).toMatchObject({ status: 'IN_PROGRESS', resolvedAt: null });

    // an agent picking up an unassigned ticket self-assigns; an admin must assign first
    const open = (await t.api.call('GET', '/tickets?unassigned=true&status=OPEN&pageSize=1', admin)).body.items[0];
    expect((await t.api.call('PATCH', `/tickets/${open.ticketId}`, admin, { status: 'IN_PROGRESS' })).status).toBe(400);
    expect((await t.api.call('PATCH', `/tickets/${open.ticketId}`, agent2, { status: 'IN_PROGRESS' })).body.assigneeId).toBe(agent2.userId);

    // details and triage
    const edit = await t.api.call('PATCH', `/tickets/${ticketId}`, agent1, { priority: 'URGENT', title: 'Order #1042 not delivered', orderRef: 'ORD-1042-B', channel: 'PHONE' });
    expect(edit.body).toMatchObject({ priority: 'URGENT', title: 'Order #1042 not delivered', orderRef: 'ORD-1042-B', channel: 'PHONE' });
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent2, { priority: 'LOW' })).status).toBe(403);

    // a closed throw-away ticket
    const temp = (await t.api.call('POST', '/tickets', agent2, ticketBody({ contactId, title: 'Close me' }))).body.ticketId;
    await t.api.call('PATCH', `/tickets/${temp}`, agent2, { status: 'RESOLVED' });
    const closed = await t.api.call('PATCH', `/tickets/${temp}`, agent2, { status: 'CLOSED' });
    expect(closed.body.closedAt).not.toBeNull();
    expect((await t.api.call('PATCH', `/tickets/${temp}`, admin, { status: 'IN_PROGRESS' })).body.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect((await t.api.call('PATCH', `/tickets/${temp}`, admin, { priority: 'LOW' })).body.error.code).toBe('TICKET_CLOSED');
    expect((await t.api.call('POST', `/tickets/${temp}/comments`, agent2, { text: 'late', visibility: 'INTERNAL' })).status).toBe(409);
    expect((await t.api.upload(temp, agent2, 'late.png', 'image/png', PNG)).status).toBe(409);
  });

  it('concurrency: a stale version gets 409 and simultaneous writers are serialised', async () => {
    const cur = (await t.api.call('GET', `/tickets/${ticketId}`, agent1)).body;
    const stale = await t.api.call('PATCH', `/tickets/${ticketId}`, agent1, { priority: 'HIGH', version: cur.version - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    const results = await Promise.all([
      t.api.call('PATCH', `/tickets/${ticketId}`, agent1, { priority: 'HIGH', version: cur.version }),
      t.api.call('PATCH', `/tickets/${ticketId}`, admin, { priority: 'LOW', version: cur.version }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]); // exactly one wins
  });

  it('search, filter, pagination and /tickets/my', async () => {
    expect((await t.api.call('GET', '/tickets/search?q=ORD-1042-B', agent2)).body.total).toBe(1); // order reference
    expect((await t.api.call('GET', '/tickets/search?q=%233', agent2)).body.items.map((x: any) => x.ticketNumber)).toEqual([3]); // "#3"
    expect((await t.api.call('GET', '/tickets/search?q=700111', agent2)).body.total).toBe(1); // contact phone
    expect((await t.api.call('GET', '/tickets/search?q=kevin', agent2)).body.total).toBe(1); // contact name
    expect((await t.api.call('GET', '/tickets/search?q=parallel', globexAgent)).body.total).toBe(0); // other org
    expect((await t.api.call('GET', '/tickets/search?q=', agent1)).status).toBe(400);

    expect((await t.api.call('GET', '/tickets?channel=INSTAGRAM', agent1)).body.total).toBe(5);
    expect((await t.api.call('GET', '/tickets?type=PAYMENT', agent1)).body.total).toBe(1);
    expect((await t.api.call('GET', `/tickets?contactId=${contactId}&status=OPEN`, agent1)).body.total).toBeGreaterThan(0);
    const page2 = await t.api.call('GET', '/tickets?channel=INSTAGRAM&page=2&pageSize=3&order=asc', agent1);
    expect(page2.body).toMatchObject({ page: 2, pageSize: 3, total: 5, totalPages: 2 });
    expect(page2.body.items).toHaveLength(2);
    expect((await t.api.call('GET', '/tickets?pageSize=1000', agent1)).status).toBe(400);

    const mine = await t.api.call('GET', '/tickets/my?pageSize=100', agent1);
    expect(mine.body.items.every((x: any) => x.assigneeId === agent1.userId)).toBe(true);
    expect(mine.body.total).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------- comments
  it('comments: public replies and internal notes, visibility required, author shown', async () => {
    expect((await t.api.call('POST', `/tickets/${ticketId}/comments`, agent1, { text: 'no visibility' })).status).toBe(400);
    expect((await t.api.call('POST', `/tickets/${ticketId}/comments`, agent1, { text: '', visibility: 'PUBLIC' })).status).toBe(400);
    const pub = await t.api.call('POST', `/tickets/${ticketId}/comments`, agent1, { text: 'Hi Amina, the courier has your parcel.', visibility: 'PUBLIC' });
    expect(pub.body).toMatchObject({ visibility: 'PUBLIC', authorType: 'STAFF', authorName: 'Agent One', authorRole: 'AGENT' });
    await t.api.call('POST', `/tickets/${ticketId}/comments`, agent2, { text: 'INTERNAL: courier is G4S, ref 998.', visibility: 'INTERNAL' });

    const list = await t.api.call('GET', `/tickets/${ticketId}/comments`, agent2);
    expect(list.body.items.map((c: any) => c.visibility)).toEqual(['PUBLIC', 'INTERNAL']);
    expect((await t.api.call('GET', `/tickets/${ticketId}/comments`, globexAgent)).status).toBe(404);
    expect((await t.api.call('DELETE', `/comments/${pub.body.commentId}`, agent2)).status).toBe(403);

    await t.services.notifier.flush();
    expect(t.email.sent.some((m) => m.to.includes('agent1@acme.com') && m.text.includes('G4S'))).toBe(true); // assignee told of the note
  });

  // ---------------------------------------------------------------- attachments
  it('attachments: validated; INTERNAL by default; tenant-prefixed storage; no storage key leaked; delete rules', async () => {
    const internal = await t.api.upload(ticketId, agent1, 'error.png', 'image/png', PNG);
    expect(internal.status).toBe(201);
    expect(internal.body).toMatchObject({ fileName: 'error.png', fileType: 'image/png', uploadedBy: agent1.userId, visibility: 'INTERNAL' });
    expect(internal.body.url).toBe(`/api/v1/attachments/${internal.body.attachmentId}/download`);
    expect(internal.body.fileUrl).toBeUndefined();
    expect([...t.storage.files.keys()][0]).toMatch(new RegExp(`^acme-store/tickets/${ticketId}/`));

    const before = t.storage.files.size;
    expect((await t.api.upload(ticketId, agent1, 'run.exe', 'application/x-msdownload', Buffer.from('MZ'))).status).toBe(415);
    expect((await t.api.upload(ticketId, agent1, 'fake.png', 'image/png', Buffer.from('not a png at all'))).status).toBe(415);
    expect((await t.api.upload(ticketId, agent1, 'a.pdf', 'image/png', PNG)).status).toBe(415);
    expect((await t.api.upload(ticketId, agent1, 'big.png', 'image/png', Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))).status).toBe(413);
    expect((await t.api.upload(ticketId, globexAgent, 'x.png', 'image/png', PNG)).status).toBe(404);
    expect(t.storage.files.size).toBe(before); // rejected uploads never reach storage

    const pub = await t.api.upload(ticketId, agent1, '../../receipt.pdf', 'application/pdf', Buffer.from('%PDF-1.4 receipt'), '?visibility=PUBLIC');
    expect(pub.body).toMatchObject({ fileName: 'receipt.pdf', visibility: 'PUBLIC' });
    expect((await t.api.upload(ticketId, agent1, 'third.png', 'image/png', PNG)).body.error.code).toBe('TOO_MANY_ATTACHMENTS');

    const dl = await t.api.call('GET', `/attachments/${internal.body.attachmentId}/download`, agent2);
    expect(dl.status).toBe(200);
    expect(dl.raw.headers['x-content-type-options']).toBe('nosniff');
    expect((await t.api.call('GET', `/attachments/${internal.body.attachmentId}/download`, globexAgent)).status).toBe(404);
    expect((await t.api.call('DELETE', `/attachments/${internal.body.attachmentId}`, agent2)).status).toBe(403);
  });

  // ---------------------------------------------------------------- customer tracking
  it('tracking: a staff member creates a link; the customer sees public information only, no login needed', async () => {
    const link = await t.api.call('POST', `/tickets/${ticketId}/tracking-link`, agent1);
    expect(link.status).toBe(201);
    expect(link.raw.headers['cache-control']).toBe('no-store');
    trackingToken = link.body.token;
    expect(trackingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.body).toMatchObject({ path: `/track/${trackingToken}`, url: `https://app.example.test/track/${trackingToken}` });
    const stored = await t.db.select().from(schema.trackingTokens);
    expect(stored.map((s) => s.tokenHash)).toContain(hashToken(trackingToken));
    expect(JSON.stringify(stored)).not.toContain(trackingToken); // only the hash is stored
    expect((await t.api.call('GET', `/tickets/${ticketId}/tracking-link`, agent2)).body.active).toBe(true);

    const view = await t.api.call('GET', `/public/tickets/${trackingToken}`);
    expect(view.status).toBe(200);
    expect(view.raw.headers['cache-control']).toBe('no-store');
    expect(view.raw.headers['referrer-policy']).toBe('no-referrer');
    expect(view.body).toMatchObject({
      ticket: { ticketNumber: 1, title: 'Order #1042 not delivered', status: 'IN_PROGRESS' },
      organization: { name: 'Acme Store', logo: 'https://cdn.example/acme.png' },
      contact: { name: 'Amina Hassan' },
      canReply: true,
    });
    expect(view.body.comments.map((c: any) => c.text)).toEqual(['Hi Amina, the courier has your parcel.']);
    expect(view.body.attachments.map((a: any) => a.fileName)).toEqual(['receipt.pdf']);
    const raw = JSON.stringify(view.body);
    for (const secret of ['G4S', 'INTERNAL', 'error.png', 'agent1@acme.com', agent1.userId, 'priority', 'assignee', 'tenantId', 'version', '0712345678']) {
      expect(raw).not.toContain(secret);
    }

    // attachments through the token: public ones of THIS ticket only
    const internalId = (await t.api.call('GET', `/tickets/${ticketId}/attachments`, agent1)).body.find((a: any) => a.visibility === 'INTERNAL').attachmentId;
    const publicId = view.body.attachments[0].attachmentId;
    expect((await t.api.call('GET', `/public/tickets/${trackingToken}/attachments/${publicId}`)).status).toBe(200);
    expect((await t.api.call('GET', `/public/tickets/${trackingToken}/attachments/${internalId}`)).status).toBe(404);
  });

  it('tracking: the customer replies; the reply reaches the agent\'s conversation and brings a waiting ticket back', async () => {
    await t.api.call('PATCH', `/tickets/${ticketId}`, agent1, { status: 'WAITING_ON_CUSTOMER' });
    expect((await t.api.call('POST', `/public/tickets/${trackingToken}/comments`, undefined, { text: '' })).status).toBe(400);
    const reply = await t.api.call('POST', `/public/tickets/${trackingToken}/comments`, undefined, { text: 'Still nothing, please check!', visibility: 'INTERNAL' });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ text: 'Still nothing, please check!', authorType: 'CONTACT', authorName: 'Amina Hassan' });

    const staffView = await t.api.call('GET', `/tickets/${ticketId}/comments?pageSize=100`, agent1);
    const last = staffView.body.items.at(-1);
    expect(last).toMatchObject({ text: 'Still nothing, please check!', visibility: 'PUBLIC', authorType: 'CONTACT', authorContactId: contactId, authorId: null });
    expect((await t.api.call('GET', `/tickets/${ticketId}`, agent1)).body.status).toBe('IN_PROGRESS');

    await t.services.notifier.flush();
    expect(t.email.sent.some((m) => m.to.includes('agent1@acme.com') && m.subject.includes('Customer replied'))).toBe(true);
  });

  it('tracking: tokens cannot be guessed or reused across tickets; replaced, revoked and expired links are rejected', async () => {
    const other = (await t.api.call('GET', '/tickets/search?q=kevin', agent2)).body.items[0];
    const otherLink = (await t.api.call('POST', `/tickets/${other.ticketId}/tracking-link`, agent2)).body.token;
    const publicOfMain = (await t.api.call('GET', `/public/tickets/${trackingToken}`)).body.attachments[0].attachmentId;
    expect((await t.api.call('GET', `/public/tickets/${otherLink}/attachments/${publicOfMain}`)).status).toBe(404); // not this ticket's

    const tampered = trackingToken.slice(0, -1) + (trackingToken.endsWith('A') ? 'B' : 'A');
    for (const bad of [tampered, 'short', `${trackingToken}x`]) {
      const r = await t.api.call('GET', `/public/tickets/${bad}`);
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('TRACKING_LINK_INVALID');
    }

    // a new link replaces the old one (one active link per ticket)
    const replacement = (await t.api.call('POST', `/tickets/${ticketId}/tracking-link`, agent1)).body.token;
    expect((await t.api.call('GET', `/public/tickets/${trackingToken}`)).status).toBe(404);
    expect((await t.api.call('GET', `/public/tickets/${replacement}`)).status).toBe(200);

    // revoke
    expect((await t.api.call('POST', `/tickets/${ticketId}/tracking-link/revoke`, globexAgent)).status).toBe(404);
    expect((await t.api.call('POST', `/tickets/${ticketId}/tracking-link/revoke`, agent2)).status).toBe(204);
    expect((await t.api.call('GET', `/public/tickets/${replacement}`)).status).toBe(404);
    expect((await t.api.call('POST', `/public/tickets/${replacement}/comments`, undefined, { text: 'hi' })).status).toBe(404);
    expect((await t.api.call('GET', `/tickets/${ticketId}/tracking-link`, agent2)).body.active).toBe(false);

    // expiry
    await t.db.update(schema.trackingTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.trackingTokens.tokenHash, hashToken(otherLink)));
    expect((await t.api.call('GET', `/public/tickets/${otherLink}`)).status).toBe(404);

    // closed ticket: visible, no replies
    const fresh = (await t.api.call('POST', `/tickets/${other.ticketId}/tracking-link`, agent2)).body.token;
    await t.api.call('PATCH', `/tickets/${other.ticketId}`, agent2, { status: 'RESOLVED' });
    await t.api.call('PATCH', `/tickets/${other.ticketId}`, agent2, { status: 'CLOSED' });
    const closedView = await t.api.call('GET', `/public/tickets/${fresh}`);
    expect(closedView.body).toMatchObject({ ticket: { status: 'CLOSED' }, canReply: false });
    expect((await t.api.call('POST', `/public/tickets/${fresh}/comments`, undefined, { text: 'reopen?' })).body.error.code).toBe('TICKET_CLOSED');
  });

  // ---------------------------------------------------------------- isolation
  it('tenant isolation: another organization never sees or touches tickets, contacts, comments or attachments', async () => {
    for (const as of [globexAdmin, globexAgent]) {
      expect((await t.api.call('GET', `/tickets/${ticketId}`, as)).status).toBe(404);
      expect((await t.api.call('PATCH', `/tickets/${ticketId}`, as, { priority: 'LOW' })).status).toBe(404);
      expect((await t.api.call('POST', `/tickets/${ticketId}/comments`, as, { text: 'hi', visibility: 'PUBLIC' })).status).toBe(404);
      expect((await t.api.call('GET', `/tickets/${ticketId}/attachments`, as)).status).toBe(404);
      expect((await t.api.call('POST', `/tickets/${ticketId}/tracking-link`, as)).status).toBe(404);
      expect((await t.api.call('GET', `/contacts/${contactId}`, as)).status).toBe(404);
      // naming acme in the header does not help a non-member
      expect((await t.api.call('GET', `/tickets/${ticketId}`, { ...as, orgId: 'acme-store' })).status).toBe(403);
    }
    expect((await t.api.call('GET', `/users/${agent2.userId}`, globexAdmin)).status).toBe(404);
    expect((await t.api.call('GET', `/audit-logs?entityType=TICKET&entityId=${ticketId}`, globexAdmin)).body.total).toBe(0);
    expect((await t.api.call('GET', '/tickets?pageSize=100', globexAgent)).body.items.every((x: any) => x.tenantId === 'globex-shop')).toBe(true);
  });

  // ---------------------------------------------------------------- dashboard and audit
  it('dashboard: ticket totals by status, recent tickets and workload per assignee', async () => {
    const d = await t.api.call('GET', '/dashboard/overview', agent1);
    expect(d.status).toBe(200);
    const { totals } = d.body;
    expect(totals.total).toBe(totals.OPEN + totals.IN_PROGRESS + totals.WAITING_ON_CUSTOMER + totals.RESOLVED + totals.CLOSED);
    expect(totals.total).toBe((await t.api.call('GET', '/tickets', agent1)).body.total);
    expect(totals.CLOSED).toBe(2);
    expect(d.body.recentTickets).toHaveLength(5);
    expect(d.body.assigned.mine).toBeGreaterThan(0);
    expect(d.body.assigned.byAssignee.some((a: any) => a.name === 'Agent One')).toBe(true);
    expect((await t.api.call('GET', '/dashboard/overview', globexAgent)).body.totals.total).toBe(1);
  });

  it('audit log: who did what, scoped to the organization, admin only', async () => {
    expect((await t.api.call('GET', '/audit-logs', agent1)).status).toBe(403);
    const r = await t.api.call('GET', `/audit-logs?entityType=TICKET&entityId=${ticketId}&pageSize=100`, admin);
    const actions = r.body.items.map((a: any) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'TICKET_CREATED', 'TICKET_ASSIGNED', 'TICKET_STATUS_CHANGED', 'TICKET_PRIORITY_CHANGED', 'TICKET_UPDATED',
        'COMMENT_ADDED', 'ATTACHMENT_ADDED', 'TRACKING_LINK_CREATED', 'TRACKING_LINK_REVOKED',
      ]),
    );
    const customerReply = r.body.items.find((a: any) => a.action === 'COMMENT_ADDED' && a.metadata.via === 'TRACKING_LINK');
    expect(customerReply).toMatchObject({ actorId: null, metadata: { contactId } });
    expect(r.body.items.find((a: any) => a.action === 'TICKET_STATUS_CHANGED' && a.metadata.to === 'RESOLVED')).toMatchObject({ actorRole: 'AGENT', actorName: 'Agent One' });

    const staff = await t.api.call('GET', '/audit-logs?entityType=INVITATION&pageSize=100', admin);
    expect(staff.body.items.map((a: any) => a.action)).toEqual(expect.arrayContaining(['INVITATION_CREATED', 'INVITATION_ACCEPTED', 'INVITATION_REVOKED']));
    const members = await t.api.call('GET', '/audit-logs?entityType=USER&pageSize=100', admin);
    expect(members.body.items.some((a: any) => a.action === 'MEMBER_DEACTIVATED')).toBe(true);
    const byActor = await t.api.call('GET', `/audit-logs?actorId=${agent2.userId}&pageSize=100`, admin);
    expect(byActor.body.items.every((a: any) => a.actorId === agent2.userId && a.tenantId === 'acme-store')).toBe(true);
  });

  // ---------------------------------------------------------------- abuse protection
  it('public routes are rate limited per client, and tokens never appear in logged URLs', async () => {
    expect(redactUrl(`/api/v1/public/tickets/${trackingToken}/comments`)).toBe('/api/v1/public/tickets/[redacted]/comments');
    expect(redactUrl('/api/v1/public/invitations/abc?x=1')).toBe('/api/v1/public/invitations/[redacted]?x=1');

    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await t.api.call('POST', '/public/tickets/guess/comments', undefined, { text: 'x' }, {}, '203.0.113.9')).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
