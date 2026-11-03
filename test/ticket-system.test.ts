import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

describe('Customer Support Ticket System', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let alice: { token: string; userId: number };
  let bob: { token: string; userId: number };
  let agent1: { token: string; userId: number };
  let agent2: { token: string; userId: number };
  let ticketId: number;

  beforeAll(async () => {
    t = await createTestApp();
    alice = await t.api.register('Alice', 'alice@x.com');
    bob = await t.api.register('Bob', 'bob@x.com');
    for (const n of [1, 2]) {
      const r = await t.api.call('POST', '/users', t.admin.token, { name: `Agent${n}`, email: `agent${n}@x.com`, password: 'password123', role: 'AGENT' });
      expect(r.status).toBe(201);
    }
    agent1 = await t.api.login('agent1@x.com', 'password123');
    agent2 = await t.api.login('agent2@x.com', 'password123');
  });
  afterAll(() => t.close());

  it('auth: rejects missing token, bad login, duplicate email, weak password; never leaks passwordHash', async () => {
    expect((await t.api.call('GET', '/tickets')).status).toBe(401);
    expect((await t.api.call('POST', '/auth/login', undefined, { email: 'alice@x.com', password: 'wrong-pass' })).status).toBe(401);
    expect((await t.api.call('POST', '/auth/register', undefined, { name: 'A', email: 'alice@x.com', password: 'password123' })).status).toBe(409);
    expect((await t.api.call('POST', '/auth/register', undefined, { name: 'A', email: 'n@x.com', password: 'short' })).status).toBe(400);
    const me = await t.api.call('GET', `/users/${alice.userId}`, alice.token);
    expect(me.body.passwordHash).toBeUndefined();
    expect(me.body.role).toBe('CUSTOMER');
  });

  it('create ticket: validates input, defaults status OPEN / priority MEDIUM, notifies agents', async () => {
    expect((await t.api.call('POST', '/tickets', alice.token, { title: '  ', description: 'x' })).status).toBe(400);
    expect((await t.api.call('POST', '/tickets', alice.token, { title: 'x', description: 'y', priority: 'NOPE' })).status).toBe(400);
    const r = await t.api.call('POST', '/tickets', alice.token, { title: 'Where is my order #1042?', description: 'Ordered 5 days ago, no update.' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'OPEN', priority: 'MEDIUM', requesterId: alice.userId, assigneeId: null, version: 1 });
    ticketId = r.body.ticketId;
    await t.services.notifier.flush();
    const mail = t.email.sent.find((m) => m.subject.includes(`#${ticketId}`));
    expect(mail?.to.sort()).toEqual(['agent1@x.com', 'agent2@x.com']);
  });

  it('role-based access: customers only see their own tickets; staff see all; users list is staff-only', async () => {
    expect((await t.api.call('GET', `/tickets/${ticketId}`, bob.token)).status).toBe(404);
    expect((await t.api.call('GET', `/tickets/${ticketId}`, alice.token)).status).toBe(200);
    expect((await t.api.call('GET', `/tickets/${ticketId}`, agent1.token)).status).toBe(200);
    expect((await t.api.call('GET', '/tickets', bob.token)).body.total).toBe(0);
    expect((await t.api.call('GET', '/tickets', agent1.token)).body.total).toBe(1);
    expect((await t.api.call('GET', '/users', alice.token)).status).toBe(403);
    expect((await t.api.call('GET', '/users?role=AGENT', agent1.token)).body.total).toBe(2);
    expect((await t.api.call('POST', '/users', agent1.token, { name: 'X', email: 'x@x.com', password: 'password123', role: 'ADMIN' })).status).toBe(403);
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, alice.token, { status: 'IN_PROGRESS' })).status).toBe(403);
  });

  it('workflow: agent self-assigns by moving to IN_PROGRESS; invalid transitions are rejected', async () => {
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent1.token, { status: 'RESOLVED' })).body.error.code).toBe('INVALID_STATUS_TRANSITION'); // OPEN -> RESOLVED
    const r = await t.api.call('PATCH', `/tickets/${ticketId}`, agent1.token, { status: 'IN_PROGRESS' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'IN_PROGRESS', assigneeId: agent1.userId, version: 2 });
  });

  it('edge: agent re-assignment while IN_PROGRESS is admin-only; assignee must be an existing agent', async () => {
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent2.token, { assigneeId: agent2.userId })).status).toBe(403);
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent1.token, { assigneeId: agent2.userId })).status).toBe(403);
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, t.admin.token, { assigneeId: 99999 })).status).toBe(400);
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, t.admin.token, { assigneeId: alice.userId })).status).toBe(400); // not an agent
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, t.admin.token, { assigneeId: null })).status).toBe(409); // in-progress must stay assigned
    const r = await t.api.call('PATCH', `/tickets/${ticketId}`, t.admin.token, { assigneeId: agent2.userId });
    expect(r.status).toBe(200);
    expect(r.body.assigneeId).toBe(agent2.userId);
    await t.services.notifier.flush();
    expect(t.email.sent.some((m) => m.to.includes('agent2@x.com') && m.subject.includes('Assigned'))).toBe(true);
    expect(t.email.sent.some((m) => m.to.includes('agent1@x.com') && m.text.includes('reassigned'))).toBe(true);
  });

  it('edge: concurrent updates - stale version gets 409, simultaneous writers are serialised', async () => {
    const cur = (await t.api.call('GET', `/tickets/${ticketId}`, agent2.token)).body;
    const stale = await t.api.call('PATCH', `/tickets/${ticketId}`, agent2.token, { priority: 'HIGH', version: cur.version - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const ok = await t.api.call('PATCH', `/tickets/${ticketId}`, agent2.token, { priority: 'HIGH', version: cur.version });
    expect(ok.body).toMatchObject({ priority: 'HIGH', version: cur.version + 1 });

    const v = ok.body.version;
    const results = await Promise.all([
      t.api.call('PATCH', `/tickets/${ticketId}`, agent2.token, { priority: 'URGENT', version: v }),
      t.api.call('PATCH', `/tickets/${ticketId}`, t.admin.token, { priority: 'LOW', version: v }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('comments: users and agents can comment; other customers cannot; counterpart is notified', async () => {
    expect((await t.api.call('POST', `/tickets/${ticketId}/comments`, alice.token, { text: '' })).status).toBe(400);
    expect((await t.api.call('POST', `/tickets/${ticketId}/comments`, bob.token, { text: 'hi' })).status).toBe(404);
    const c = await t.api.call('POST', `/tickets/${ticketId}/comments`, alice.token, { text: 'Any update please?' });
    expect(c.status).toBe(201);
    await t.api.call('POST', `/tickets/${ticketId}/comments`, agent2.token, { text: 'Checking with the courier.' });
    const list = await t.api.call('GET', `/tickets/${ticketId}/comments`, alice.token);
    expect(list.body.items.map((x: any) => x.text)).toEqual(['Any update please?', 'Checking with the courier.']);
    await t.services.notifier.flush();
    expect(t.email.sent.some((m) => m.to.includes('alice@x.com') && m.text.includes('courier'))).toBe(true);
    expect((await t.api.call('DELETE', `/comments/${c.body.commentId}`, bob.token)).status).toBe(404);
    expect((await t.api.call('DELETE', `/comments/${c.body.commentId}`, agent2.token)).status).toBe(403);
    expect((await t.api.call('DELETE', `/comments/${c.body.commentId}`, alice.token)).status).toBe(204);
  });

  it('attachments: validates type, size, magic bytes, count; secure download; delete rules', async () => {
    const ok = await t.api.upload(ticketId, alice.token, 'error.png', 'image/png', PNG);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ fileName: 'error.png', fileType: 'image/png', uploadedBy: alice.userId });
    expect(ok.body.url).toBe(`/attachments/${ok.body.attachmentId}/download`);

    expect((await t.api.upload(ticketId, alice.token, 'run.exe', 'application/x-msdownload', Buffer.from('MZ'))).status).toBe(415);
    expect((await t.api.upload(ticketId, alice.token, 'fake.png', 'image/png', Buffer.from('not a png at all'))).status).toBe(415);
    expect((await t.api.upload(ticketId, alice.token, 'a.pdf', 'image/png', PNG)).status).toBe(415);
    expect((await t.api.upload(ticketId, alice.token, 'big.png', 'image/png', Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))).status).toBe(413);
    expect((await t.api.upload(ticketId, bob.token, 'x.png', 'image/png', PNG)).status).toBe(404);
    expect((await t.api.upload(ticketId, agent2.token, '../../etc/passwd.log', 'text/plain', Buffer.from('log line'))).status).toBe(201);
    expect((await t.api.upload(ticketId, alice.token, 'third.png', 'image/png', PNG)).status).toBe(409); // max 2 in this test env

    const files = await t.api.call('GET', `/tickets/${ticketId}/attachments`, alice.token);
    expect(files.body).toHaveLength(2);
    expect(files.body[1].fileName).toBe('passwd.log'); // path traversal stripped

    const dl = await t.api.call('GET', `/attachments/${ok.body.attachmentId}/download`, alice.token);
    expect(dl.status).toBe(200);
    expect(dl.raw.headers['content-type']).toBe('image/png');
    expect(dl.raw.headers['x-content-type-options']).toBe('nosniff');
    expect((await t.api.call('GET', `/attachments/${ok.body.attachmentId}/download`, bob.token)).status).toBe(404);
    expect((await t.api.call('DELETE', `/attachments/${ok.body.attachmentId}`, agent2.token)).status).toBe(403);
    expect((await t.api.call('DELETE', `/attachments/${ok.body.attachmentId}`, alice.token)).status).toBe(204);
    expect(t.storage.files.size).toBe(1);
  });

  it('search, filter, pagination and /tickets/my', async () => {
    for (let i = 1; i <= 4; i++) await t.api.call('POST', '/tickets', alice.token, { title: `Return request ${i}`, description: 'Wrong size', priority: i % 2 ? 'LOW' : 'URGENT' });
    await t.api.call('POST', '/tickets', bob.token, { title: 'Change shipping address', description: 'Moved house 100%_sure' });

    const s = await t.api.call('GET', '/tickets/search?q=return', agent1.token);
    expect(s.body.total).toBe(4);
    expect((await t.api.call('GET', '/tickets/search?q=return', bob.token)).body.total).toBe(0); // scoped for customers
    expect((await t.api.call('GET', '/tickets/search?q=100%25_sure', agent1.token)).body.total).toBe(1); // LIKE wildcards escaped
    expect((await t.api.call('GET', '/tickets/search?q=', agent1.token)).status).toBe(400);

    expect((await t.api.call('GET', '/tickets?priority=URGENT', agent1.token)).body.total).toBe(3);
    expect((await t.api.call('GET', '/tickets?status=OPEN&priority=LOW', agent1.token)).body.total).toBe(2);
    const p = await t.api.call('GET', '/tickets?page=2&pageSize=2&order=asc', agent1.token);
    expect(p.body).toMatchObject({ page: 2, pageSize: 2, total: 6, totalPages: 3 });
    expect(p.body.items).toHaveLength(2);
    expect((await t.api.call('GET', '/tickets?pageSize=1000', agent1.token)).status).toBe(400);

    expect((await t.api.call('GET', '/tickets/my', agent2.token)).body.total).toBe(1); // assigned to me
    expect((await t.api.call('GET', '/tickets/my', alice.token)).body.total).toBe(5); // raised by me
  });

  it('resolution flow: agent resolves -> requester notified -> requester closes -> closed is terminal', async () => {
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, agent2.token, { status: 'RESOLVED' })).status).toBe(200);
    await t.services.notifier.flush();
    expect(t.email.sent.some((m) => m.to.includes('alice@x.com') && m.subject.includes('IN_PROGRESS -> RESOLVED'))).toBe(true);

    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, alice.token, { priority: 'LOW' })).status).toBe(403);
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, bob.token, { status: 'CLOSED' })).status).toBe(404);
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, alice.token, { status: 'CLOSED' })).status).toBe(200);

    const reopen = await t.api.call('PATCH', `/tickets/${ticketId}`, t.admin.token, { status: 'OPEN' }); // CLOSED -> OPEN
    expect(reopen.status).toBe(409);
    expect(reopen.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect((await t.api.call('PATCH', `/tickets/${ticketId}`, t.admin.token, { priority: 'LOW' })).body.error.code).toBe('TICKET_CLOSED');
    expect((await t.api.call('POST', `/tickets/${ticketId}/comments`, alice.token, { text: 'late' })).status).toBe(409);
    expect((await t.api.upload(ticketId, alice.token, 'late.png', 'image/png', PNG)).status).toBe(409);
    expect((await t.api.call('GET', '/tickets/999999', agent1.token)).status).toBe(404);
  });

  it('audit log records who did what, admin only', async () => {
    expect((await t.api.call('GET', '/audit-logs', agent1.token)).status).toBe(403);
    const r = await t.api.call('GET', `/audit-logs?entityType=TICKET&entityId=${ticketId}&pageSize=100`, t.admin.token);
    const actions = r.body.items.map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['TICKET_CREATED', 'TICKET_ASSIGNED', 'TICKET_STATUS_CHANGED', 'TICKET_PRIORITY_CHANGED', 'COMMENT_ADDED', 'COMMENT_DELETED', 'ATTACHMENT_ADDED', 'ATTACHMENT_DELETED']));
    const closed = r.body.items.find((a: any) => a.action === 'TICKET_STATUS_CHANGED' && a.metadata.to === 'CLOSED');
    expect(closed).toMatchObject({ actorId: alice.userId, metadata: { from: 'RESOLVED', to: 'CLOSED' } });
  });
});
