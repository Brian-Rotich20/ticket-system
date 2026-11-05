import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Session } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

describe('Customer Support Ticket System (multi-tenant)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: Session;
  let globexAdmin: Session;
  let alice: Session; // acme customer
  let bob: Session; // acme customer
  let dave: Session; // acme customer (used for filter/pagination counts)
  let gina: Session; // globex customer
  let agent1: Session; // acme agents
  let agent2: Session;
  let globexAgent: Session;
  let ticketId: number; // the main ticket, created by alice

  beforeAll(async () => {
    t = await createTestApp();
    ({ admin, globexAdmin } = t);
    alice = await t.api.register('Alice', 'alice@acme.com', 'acme');
    bob = await t.api.register('Bob', 'bob@acme.com', 'acme');
    dave = await t.api.register('Dave', 'dave@acme.com', 'acme');
    gina = await t.api.register('Gina', 'gina@globex.com', 'globex');
    agent1 = await t.api.createStaff(admin.token, 'Agent One', 'agent1@acme.com', 'AGENT');
    agent2 = await t.api.createStaff(admin.token, 'Agent Two', 'agent2@acme.com', 'AGENT');
    globexAgent = await t.api.createStaff(globexAdmin.token, 'Globex Agent', 'agent@globex.com', 'AGENT');
  });
  afterAll(() => t.close());

  // ---------------------------------------------------------------- auth
  it('auth: sign-up needs an existing tenant, rejects duplicates and weak passwords', async () => {
    const base = { name: 'X', email: 'x@acme.com', password: 'password123' };
    const signUp = (body: object) => t.api.call('POST', '/api/auth/sign-up/email', undefined, body);
    expect((await signUp(base)).status).toBe(400); // no tenantId
    expect((await signUp({ ...base, tenantId: 'nope' })).status).toBe(400); // unknown tenant
    expect((await signUp({ ...base, email: 'alice@acme.com', tenantId: 'acme' })).status).toBe(422); // duplicate email
    expect((await signUp({ ...base, password: 'short', tenantId: 'acme' })).status).toBe(400);
  });

  it('auth: protected routes need a session; the session carries tenant + role; no credential leaks', async () => {
    expect((await t.api.call('GET', '/tickets')).status).toBe(401);
    expect((await t.api.call('GET', '/tickets', 'not-a-real-token')).status).toBe(401);
    expect((await t.api.call('POST', '/api/auth/sign-in/email', undefined, { email: 'alice@acme.com', password: 'wrong-pass-123' })).status).toBe(401);

    const session = await t.api.call('GET', '/api/auth/get-session', alice.token);
    expect(session.body.user).toMatchObject({ email: 'alice@acme.com', tenantId: 'acme', role: 'CUSTOMER' });

    const me = await t.api.call('GET', `/users/${alice.userId}`, alice.token);
    expect(me.body).toMatchObject({ userId: alice.userId, tenantId: 'acme', role: 'CUSTOMER' });
    expect(JSON.stringify(me.body)).not.toMatch(/password|hash/i);
    expect((await t.api.call('GET', `/users/${bob.userId}`, alice.token)).status).toBe(403); // customers only see themselves
  });

  it('auth: nobody can self-register as staff; sign-out revokes the session', async () => {
    const r = await t.api.call('POST', '/api/auth/sign-up/email', undefined, {
      name: 'Mallory', email: 'mallory@acme.com', password: 'password123', tenantId: 'acme', role: 'ADMIN',
    });
    expect(r.status).toBe(200); // the role field is ignored, not an error
    expect((await t.api.call('GET', '/users', r.raw.headers['set-auth-token'] as string)).status).toBe(403); // still a customer

    const carol = await t.api.register('Carol', 'carol@acme.com', 'acme');
    expect((await t.api.call('GET', '/tickets', carol.token)).status).toBe(200);
    expect((await t.api.call('POST', '/api/auth/sign-out', carol.token)).status).toBe(200);
    expect((await t.api.call('GET', '/tickets', carol.token)).status).toBe(401);
  });

  // ---------------------------------------------------------------- create
  it('create ticket: validates input, applies defaults, notifies only the tenant\'s agents', async () => {
    expect((await t.api.call('POST', '/tickets', alice.token, { title: '  ', description: 'x' })).status).toBe(400);
    expect((await t.api.call('POST', '/tickets', alice.token, { title: 'x', description: 'y', priority: 'NOPE' })).status).toBe(400);

    const r = await t.api.call('POST', '/tickets', alice.token, { title: 'Where is my order #1042?', description: 'Ordered 5 days ago, no update.' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: 'OPEN', priority: 'MEDIUM', type: 'INQUIRY', tenantId: 'acme', requesterId: alice.userId, assigneeId: null, version: 1,
    });
    ticketId = r.body.ticketId;

    await t.services.notifier.flush();
    const mail = t.email.sent.find((m) => m.subject.includes(`#${ticketId}`));
    expect(mail?.to.sort()).toEqual(['agent1@acme.com', 'agent2@acme.com']); // not agent@globex.com
  });

  // ---------------------------------------------------------------- RBAC
  it('RBAC: customers see own tickets only; staff see the tenant; route guards return 401/403', async () => {
    expect((await t.api.call('GET', `/tickets/${ticketId}`, bob.token)).status).toBe(404);
    expect((await t.api.call('GET', `/tickets/${ticketId}`, alice.token)).status).toBe(200);
    expect((await t.api.call('GET', `/tickets/${ticketId}`, agent1.token)).status).toBe(200);
    expect((await t.api.call('GET', '/tickets', bob.token)).body.total).toBe(0);
    expect((await t.api.call('GET', '/tickets', agent1.token)).body.total).toBe(1);

    expect((await t.api.call('GET', '/users', alice.token)).status).toBe(403);
    expect((await t.api.call('GET', '/users?role=AGENT', agent1.token)).body.total).toBe(2);
    expect((await t.api.call('POST', '/users', agent1.token, { name: 'X', email: 'x@acme.com', password: 'password123', role: 'ADMIN' })).status).toBe(403);
    expect((await t.api.call('GET', '/audit-logs', agent1.token)).status).toBe(403);

    // only agents/admins may PATCH tickets
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, undefined, { status: 'IN_PROGRESS' })).status).toBe(401);
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, alice.token, { status: 'IN_PROGRESS' })).status).toBe(403);
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, bob.token, { status: 'IN_PROGRESS' })).status).toBe(403);
  });

  // ---------------------------------------------------------------- tenant isolation
  it('tenant isolation: another tenant can never see or touch this tenant\'s data', async () => {
    expect((await t.api.call('GET', `/tickets/${ticketId}`, gina.token)).status).toBe(404);
    expect((await t.api.call('GET', `/tickets/${ticketId}`, globexAgent.token)).status).toBe(404);
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, globexAdmin.token, { priority: 'LOW' })).status).toBe(404);
    expect((await t.api.call('POST', `/tickets/${ticketId}/comments`, gina.token, { text: 'hi' })).status).toBe(404);
    expect((await t.api.call('GET', `/tickets/${ticketId}/comments`, globexAgent.token)).status).toBe(404);
    expect((await t.api.upload(ticketId, gina.token, 'x.png', 'image/png', PNG)).status).toBe(404);

    expect((await t.api.call('GET', '/tickets', globexAgent.token)).body.total).toBe(0);
    expect((await t.api.call('GET', '/tickets/search?q=order', globexAgent.token)).body.total).toBe(0);

    // users and audit logs are tenant-scoped as well
    expect((await t.api.call('GET', `/users/${agent1.userId}`, globexAdmin.token)).status).toBe(404);
    const globexUsers = await t.api.call('GET', '/users', globexAdmin.token);
    expect(globexUsers.body.items.map((u: any) => u.tenantId)).toEqual(['globex', 'globex', 'globex']); // admin, gina, agent (+ one more? see below)
    expect((await t.api.call('GET', `/audit-logs?entityType=TICKET&entityId=${ticketId}`, globexAdmin.token)).body.total).toBe(0);

    // an acme admin cannot assign a globex agent
    const cross = await t.api.call('PATCH', `/tickets/${ticketId}`, admin.token, { assigneeId: globexAgent.userId });
    expect(cross.status).toBe(400);
    expect((await t.api.call('GET', `/tickets/${ticketId}`, admin.token)).body.assigneeId).toBeNull();
  });

  // ---------------------------------------------------------------- workflow
  it('workflow: invalid transition rejected; agent picking up a ticket self-assigns; admin needs an assignee', async () => {
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent1.token, { status: 'RESOLVED' })).body.error.code).toBe('INVALID_STATUS_TRANSITION'); // OPEN -> RESOLVED
    const r = await t.api.call('PATCH', `/tickets/${ticketId}`, agent1.token, { status: 'IN_PROGRESS' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'IN_PROGRESS', assigneeId: agent1.userId, version: 2 });

    const other = await t.api.call('POST', '/tickets', alice.token, { title: 'Second ticket', description: 'for the admin check' });
    expect((await t.api.call('PATCH', `/tickets/${other.body.ticketId}`, admin.token, { status: 'IN_PROGRESS' })).status).toBe(400); // nobody assigned
  });

  it('edge: re-assigning an IN_PROGRESS ticket is admin-only; assignee must be an agent of the same tenant', async () => {
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent2.token, { assigneeId: agent2.userId })).status).toBe(403);
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent1.token, { assigneeId: agent2.userId })).status).toBe(403);
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, admin.token, { assigneeId: 'does-not-exist' })).status).toBe(400);
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, admin.token, { assigneeId: alice.userId })).status).toBe(400); // not an agent
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, admin.token, { assigneeId: null })).status).toBe(409); // in-progress must stay assigned

    const r = await t.api.call('PATCH', `/tickets/${ticketId}`, admin.token, { assigneeId: agent2.userId });
    expect(r.status).toBe(200);
    expect(r.body.assigneeId).toBe(agent2.userId);
    await t.services.notifier.flush();
    expect(t.email.sent.some((m) => m.to.includes('agent2@acme.com') && m.subject.includes('Assigned'))).toBe(true);
    expect(t.email.sent.some((m) => m.to.includes('agent1@acme.com') && m.text.includes('reassigned'))).toBe(true);
  });

  it('edge: concurrent updates - a stale version gets 409 and simultaneous writers are serialised', async () => {
    const cur = (await t.api.call('GET', `/tickets/${ticketId}`, agent2.token)).body;
    const stale = await t.api.call('PATCH', `/tickets/${ticketId}`, agent2.token, { priority: 'HIGH', version: cur.version - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    const ok = await t.api.call('PATCH', `/tickets/${ticketId}`, agent2.token, { priority: 'HIGH', version: cur.version });
    expect(ok.body).toMatchObject({ priority: 'HIGH', version: cur.version + 1 });

    const v = ok.body.version;
    const results = await Promise.all([
      t.api.call('PATCH', `/tickets/${ticketId}`, agent2.token, { priority: 'URGENT', version: v }),
      t.api.call('PATCH', `/tickets/${ticketId}`, admin.token, { priority: 'LOW', version: v }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]); // exactly one wins
  });

  // ---------------------------------------------------------------- comments
  it('comments: owner and staff can comment; others cannot; delete rules; counterpart is notified', async () => {
    expect((await t.api.call('POST', `/tickets/${ticketId}/comments`, alice.token, { text: '' })).status).toBe(400);
    expect((await t.api.call('POST', `/tickets/${ticketId}/comments`, bob.token, { text: 'hi' })).status).toBe(404);

    const c = await t.api.call('POST', `/tickets/${ticketId}/comments`, alice.token, { text: 'Any update please?' });
    expect(c.status).toBe(201);
    await t.api.call('POST', `/tickets/${ticketId}/comments`, agent2.token, { text: 'Checking with the courier.' });

    const list = await t.api.call('GET', `/tickets/${ticketId}/comments`, alice.token);
    expect(list.body.items.map((x: any) => x.text)).toEqual(['Any update please?', 'Checking with the courier.']);

    await t.services.notifier.flush();
    expect(t.email.sent.some((m) => m.to.includes('alice@acme.com') && m.text.includes('courier'))).toBe(true);

    expect((await t.api.call('DELETE', `/comments/${c.body.commentId}`, bob.token)).status).toBe(404);
    expect((await t.api.call('DELETE', `/comments/${c.body.commentId}`, agent2.token)).status).toBe(403);
    expect((await t.api.call('DELETE', `/comments/${c.body.commentId}`, alice.token)).status).toBe(204);
  });

  // ---------------------------------------------------------------- attachments
  it('attachments: validates type/size/content/count; tenant-prefixed storage; no storage key leaked; delete rules', async () => {
    const ok = await t.api.upload(ticketId, alice.token, 'error.png', 'image/png', PNG);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ fileName: 'error.png', fileType: 'image/png', uploadedBy: alice.userId });
    expect(ok.body.url).toBe(`/api/v1/attachments/${ok.body.attachmentId}/download`);
    expect(ok.body.fileUrl).toBeUndefined(); // the storage key never leaves the server
    expect([...t.storage.files.keys()][0]).toMatch(new RegExp(`^acme/tickets/${ticketId}/`));

    expect((await t.api.upload(ticketId, alice.token, 'run.exe', 'application/x-msdownload', Buffer.from('MZ'))).status).toBe(415);
    expect((await t.api.upload(ticketId, alice.token, 'fake.png', 'image/png', Buffer.from('not a png at all'))).status).toBe(415);
    expect((await t.api.upload(ticketId, alice.token, 'a.pdf', 'image/png', PNG)).status).toBe(415); // extension != type
    expect((await t.api.upload(ticketId, alice.token, 'big.png', 'image/png', Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))).status).toBe(413);
    expect((await t.api.upload(ticketId, bob.token, 'x.png', 'image/png', PNG)).status).toBe(404);
    expect((await t.api.upload(ticketId, agent2.token, '../../etc/passwd.log', 'text/plain', Buffer.from('log line'))).status).toBe(201);
    expect((await t.api.upload(ticketId, alice.token, 'third.png', 'image/png', PNG)).status).toBe(409); // max 2 in the test env

    const files = await t.api.call('GET', `/tickets/${ticketId}/attachments`, alice.token);
    expect(files.body).toHaveLength(2);
    expect(files.body[1].fileName).toBe('passwd.log'); // path traversal stripped

    const dl = await t.api.call('GET', `/attachments/${ok.body.attachmentId}/download`, alice.token);
    expect(dl.status).toBe(200);
    expect(dl.raw.headers['content-type']).toBe('image/png');
    expect(dl.raw.headers['x-content-type-options']).toBe('nosniff');
    expect((await t.api.call('GET', `/attachments/${ok.body.attachmentId}/download`, bob.token)).status).toBe(404);
    expect((await t.api.call('GET', `/attachments/${ok.body.attachmentId}/download`, gina.token)).status).toBe(404);

    expect((await t.api.call('DELETE', `/attachments/${ok.body.attachmentId}`, agent2.token)).status).toBe(403);
    expect((await t.api.call('DELETE', `/attachments/${ok.body.attachmentId}`, alice.token)).status).toBe(204);
    expect(t.storage.files.size).toBe(1);
  });

  // ---------------------------------------------------------------- ticket types
  it('ticket types: inquiries, IT requests and internal issues are filterable and re-classifiable by staff', async () => {
    expect((await t.api.call('POST', '/tickets', alice.token, { title: 'x', description: 'y', type: 'BUG' })).status).toBe(400);
    const it1 = await t.api.call('POST', '/tickets', alice.token, { title: 'VPN not connecting', description: 'Cannot reach intranet', type: 'IT_REQUEST', priority: 'HIGH' });
    const internal = await t.api.call('POST', '/tickets', bob.token, { title: 'Broken printer, 2nd floor', description: 'Paper jam', type: 'INTERNAL_ISSUE' });
    expect([it1.body.type, internal.body.type]).toEqual(['IT_REQUEST', 'INTERNAL_ISSUE']);

    expect((await t.api.call('GET', '/tickets?type=IT_REQUEST', agent1.token)).body.total).toBe(1);
    expect((await t.api.call('GET', '/tickets?type=INTERNAL_ISSUE', agent1.token)).body.total).toBe(1);
    expect((await t.api.call('GET', '/tickets?type=INTERNAL_ISSUE', alice.token)).body.total).toBe(0); // customers see only their own

    expect((await t.api.call('PATCH', `/tickets/${it1.body.ticketId}`, alice.token, { type: 'INQUIRY' })).status).toBe(403);
    expect((await t.api.call('PATCH', `/tickets/${it1.body.ticketId}`, agent1.token, { type: 'INQUIRY' })).status).toBe(403); // not assigned yet
    const re = await t.api.call('PATCH', `/tickets/${it1.body.ticketId}`, agent1.token, { assigneeId: agent1.userId, type: 'INTERNAL_ISSUE' });
    expect(re.body).toMatchObject({ type: 'INTERNAL_ISSUE', assigneeId: agent1.userId });
  });

  // ---------------------------------------------------------------- search / filter / pagination
  it('search, filter, pagination and /tickets/my', async () => {
    for (let i = 1; i <= 4; i++) {
      await t.api.call('POST', '/tickets', dave.token, { title: `Refundreq number ${i}`, description: 'Wrong size', priority: i % 2 ? 'LOW' : 'URGENT' });
    }
    await t.api.call('POST', '/tickets', bob.token, { title: 'Discount 100%_off not applied', description: 'Coupon problem' });

    expect((await t.api.call('GET', '/tickets/search?q=refundreq', agent1.token)).body.total).toBe(4);
    expect((await t.api.call('GET', '/tickets/search?q=refundreq', bob.token)).body.total).toBe(0); // customers only search their own
    expect((await t.api.call('GET', '/tickets/search?q=100%25_off', agent1.token)).body.total).toBe(1); // LIKE wildcards are escaped
    expect((await t.api.call('GET', '/tickets/search?q=', agent1.token)).status).toBe(400);

    const mine = `requesterId=${dave.userId}`;
    expect((await t.api.call('GET', `/tickets?${mine}&priority=URGENT`, agent1.token)).body.total).toBe(2);
    expect((await t.api.call('GET', `/tickets?${mine}&status=OPEN&priority=LOW`, agent1.token)).body.total).toBe(2);
    const page2 = await t.api.call('GET', `/tickets?${mine}&page=2&pageSize=3&order=asc`, agent1.token);
    expect(page2.body).toMatchObject({ page: 2, pageSize: 3, total: 4, totalPages: 2 });
    expect(page2.body.items).toHaveLength(1);
    expect((await t.api.call('GET', '/tickets?pageSize=1000', agent1.token)).status).toBe(400);

    expect((await t.api.call('GET', '/tickets/my', dave.token)).body.total).toBe(4); // customer: raised by me
    expect((await t.api.call('GET', '/tickets/my', agent2.token)).body.total).toBe(1); // staff: assigned to me
  });

  // ---------------------------------------------------------------- resolution
  it('resolution flow: agent resolves -> requester notified -> agent closes -> CLOSED is terminal', async () => {
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent2.token, { status: 'RESOLVED' })).status).toBe(200);
    await t.services.notifier.flush();
    expect(t.email.sent.some((m) => m.to.includes('alice@acme.com') && m.subject.includes('IN_PROGRESS -> RESOLVED'))).toBe(true);

    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, alice.token, { status: 'CLOSED' })).status).toBe(403); // customers cannot PATCH
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent2.token, { status: 'CLOSED' })).status).toBe(200);

    const reopen = await t.api.call('PATCH', `/tickets/${ticketId}`, admin.token, { status: 'OPEN' }); // CLOSED -> OPEN
    expect(reopen.status).toBe(409);
    expect(reopen.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, admin.token, { priority: 'LOW' })).body.error.code).toBe('TICKET_CLOSED');
    expect((await t.api.call('POST', `/tickets/${ticketId}/comments`, alice.token, { text: 'late' })).status).toBe(409);
    expect((await t.api.upload(ticketId, alice.token, 'late.png', 'image/png', PNG)).status).toBe(409);
    expect((await t.api.call('GET', '/tickets/999999', agent1.token)).status).toBe(404);
  });

  // ---------------------------------------------------------------- audit
  it('audit log records who did what, scoped to the tenant, admin only', async () => {
    const r = await t.api.call('GET', `/audit-logs?entityType=TICKET&entityId=${ticketId}&pageSize=100`, admin.token);
    const actions = r.body.items.map((a: any) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'TICKET_CREATED', 'TICKET_ASSIGNED', 'TICKET_STATUS_CHANGED', 'TICKET_PRIORITY_CHANGED',
        'COMMENT_ADDED', 'COMMENT_DELETED', 'ATTACHMENT_ADDED', 'ATTACHMENT_DELETED',
      ]),
    );
    const closed = r.body.items.find((a: any) => a.action === 'TICKET_STATUS_CHANGED' && a.metadata.to === 'CLOSED');
    expect(closed).toMatchObject({ tenantId: 'acme', actorId: agent2.userId, metadata: { from: 'RESOLVED', to: 'CLOSED' } });

    const users = await t.api.call('GET', '/audit-logs?entityType=USER&pageSize=100', admin.token);
    expect(users.body.items.some((a: any) => a.action === 'USER_CREATED' && a.metadata.role === 'AGENT')).toBe(true);
    expect(users.body.items.every((a: any) => a.tenantId === 'acme')).toBe(true);
  });
});