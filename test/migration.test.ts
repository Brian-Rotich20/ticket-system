import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/config/db.js';
import * as schema from '../src/model/schema.js';
import { InMemoryStorageService } from '../src/service/storage.service.js';
import { makeClient, RecordingEmailSender, testEnv } from './helpers.js';

/** Applies one drizzle migration file statement by statement. */
async function applyMigration(client: PGlite, file: string) {
  const sql = readFileSync(`./drizzle/${file}`, 'utf8');
  await client.transaction(async (tx) => {
    for (const statement of sql.split('--> statement-breakpoint')) if (statement.trim()) await tx.exec(statement);
  });
}

const q = async <T = any>(client: PGlite, sql: string) => (await client.query<T>(sql)).rows;

/**
 * Migration 0001 on a database holding first-version data: customer accounts raising tickets, staff with global
 * roles, comments, attachments and audit history. Nothing may be lost, and history must stay reachable.
 */
describe('migration 0001: first-version data is preserved and moved onto contacts and memberships', () => {
  const client = new PGlite();

  beforeAll(async () => {
    await applyMigration(client, '0000_nosy_pandemic.sql');
    await client.exec(`
      INSERT INTO tenants (id, name) VALUES ('acme', 'Acme Store'), ('globex', 'Globex Shop');
      INSERT INTO users (id, name, email, tenant_id, role, created_at) VALUES
        ('u-admin', 'Acme Admin', 'admin@acme.com', 'acme', 'ADMIN', '2026-01-01'),
        ('u-agent', 'Acme Agent', 'agent@acme.com', 'acme', 'AGENT', '2026-01-01'),
        ('u-cust1', 'Amina Customer', 'amina@example.com', 'acme', 'CUSTOMER', '2026-01-02'),
        ('u-cust2', 'Kevin Customer', 'kevin@example.com', 'acme', 'CUSTOMER', '2026-01-02'),
        ('u-gcust', 'Grace Customer', 'grace@example.com', 'globex', 'CUSTOMER', '2026-01-02');
      INSERT INTO tickets (ticket_id, tenant_id, title, description, type, status, priority, requester_id, assignee_id, version, created_at, updated_at) VALUES
        (10, 'acme', 'Order late', 'Where is it?', 'INQUIRY', 'OPEN', 'MEDIUM', 'u-cust1', NULL, 1, '2026-02-01', '2026-02-01'),
        (11, 'acme', 'VPN broken', 'Cannot connect', 'IT_REQUEST', 'RESOLVED', 'HIGH', 'u-cust1', 'u-agent', 3, '2026-02-02', '2026-02-05'),
        (12, 'acme', 'Printer jam', 'Again', 'INTERNAL_ISSUE', 'CLOSED', 'LOW', 'u-cust2', 'u-agent', 4, '2026-02-03', '2026-02-06'),
        (13, 'globex', 'Refund', 'Please', 'INQUIRY', 'OPEN', 'URGENT', 'u-gcust', NULL, 1, '2026-02-04', '2026-02-04');
      SELECT setval('tickets_ticket_id_seq', 13);
      INSERT INTO comments (ticket_id, author_id, text, created_at) VALUES
        (11, 'u-cust1', 'Any update?', '2026-02-03'), (11, 'u-agent', 'Fixed now.', '2026-02-04');
      INSERT INTO attachments (ticket_id, file_url, file_name, file_type, uploaded_by) VALUES
        (11, 'acme/tickets/11/x.png', 'screenshot.png', 'image/png', 'u-cust1');
      INSERT INTO audit_logs (tenant_id, actor_id, action, entity_type, entity_id, metadata, created_at) VALUES
        ('acme', 'u-agent', 'TICKET_STATUS_CHANGED', 'TICKET', '11', '{"from":"IN_PROGRESS","to":"RESOLVED"}', '2026-02-04 10:00:00+00');
    `);
    await applyMigration(client, '0001_organizations_contacts_tracking.sql');
  });
  afterAll(() => client.close());

  it('staff keep their access as memberships; customer accounts get none', async () => {
    const members = await q(client, `SELECT tenant_id, user_id, role, status FROM organization_members ORDER BY user_id`);
    expect(members).toEqual([
      { tenant_id: 'acme', user_id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' },
      { tenant_id: 'acme', user_id: 'u-agent', role: 'AGENT', status: 'ACTIVE' },
    ]);
    expect((await q(client, `SELECT count(*)::int AS n FROM users`))[0].n).toBe(5); // no account removed
  });

  it('customer accounts become organization-scoped contacts linked to their account', async () => {
    const contacts = await q(client, `SELECT tenant_id, name, email, phone, user_id FROM contacts ORDER BY tenant_id, user_id`);
    expect(contacts).toEqual([
      { tenant_id: 'acme', name: 'Amina Customer', email: 'amina@example.com', phone: null, user_id: 'u-cust1' },
      { tenant_id: 'acme', name: 'Kevin Customer', email: 'kevin@example.com', phone: null, user_id: 'u-cust2' },
      { tenant_id: 'globex', name: 'Grace Customer', email: 'grace@example.com', phone: null, user_id: 'u-gcust' },
    ]);
  });

  it('tickets keep everything and gain contact, number, creator, channel, mapped enums and resolution dates', async () => {
    const rows = await q(
      client,
      `SELECT t.ticket_id, t.tenant_id, t.ticket_number, c.user_id AS contact_user, t.created_by, t.requester_id, t.type, t.priority,
              t.channel, t.status, t.version, to_char(t.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS resolved,
              t.closed_at IS NOT NULL AS closed
         FROM tickets t JOIN contacts c ON c.contact_id = t.contact_id ORDER BY t.ticket_id`,
    );
    expect(rows).toEqual([
      { ticket_id: 10, tenant_id: 'acme', ticket_number: 1, contact_user: 'u-cust1', created_by: 'u-cust1', requester_id: 'u-cust1', type: 'PRODUCT_INQUIRY', priority: 'NORMAL', channel: 'WEBSITE', status: 'OPEN', version: 1, resolved: null, closed: false },
      { ticket_id: 11, tenant_id: 'acme', ticket_number: 2, contact_user: 'u-cust1', created_by: 'u-cust1', requester_id: 'u-cust1', type: 'OTHER', priority: 'HIGH', channel: 'WEBSITE', status: 'RESOLVED', version: 3, resolved: '2026-02-04 10:00', closed: false },
      { ticket_id: 12, tenant_id: 'acme', ticket_number: 3, contact_user: 'u-cust2', created_by: 'u-cust2', requester_id: 'u-cust2', type: 'OTHER', priority: 'LOW', channel: 'WEBSITE', status: 'CLOSED', version: 4, resolved: '2026-02-06 00:00', closed: true },
      { ticket_id: 13, tenant_id: 'globex', ticket_number: 1, contact_user: 'u-gcust', created_by: 'u-gcust', requester_id: 'u-gcust', type: 'PRODUCT_INQUIRY', priority: 'URGENT', channel: 'WEBSITE', status: 'OPEN', version: 1, resolved: null, closed: false },
    ]);
    expect(await q(client, `SELECT id, ticket_counter FROM tenants ORDER BY id`)).toEqual([
      { id: 'acme', ticket_counter: 3 },
      { id: 'globex', ticket_counter: 1 },
    ]);
    // the original types are kept in the audit log
    const migrated = await q(client, `SELECT entity_id, metadata FROM audit_logs WHERE action = 'TICKET_TYPE_MIGRATED' ORDER BY entity_id`);
    expect(migrated.map((m) => [m.entity_id, m.metadata.from, m.metadata.to])).toEqual([
      ['10', 'INQUIRY', 'PRODUCT_INQUIRY'], ['11', 'IT_REQUEST', 'OTHER'], ['12', 'INTERNAL_ISSUE', 'OTHER'], ['13', 'INQUIRY', 'PRODUCT_INQUIRY'],
    ]);
  });

  it('existing comments and attachments are kept and stay customer-visible; new ones default to internal', async () => {
    expect(await q(client, `SELECT text, visibility, author_id FROM comments ORDER BY comment_id`)).toEqual([
      { text: 'Any update?', visibility: 'PUBLIC', author_id: 'u-cust1' },
      { text: 'Fixed now.', visibility: 'PUBLIC', author_id: 'u-agent' },
    ]);
    expect(await q(client, `SELECT file_name, visibility FROM attachments`)).toEqual([{ file_name: 'screenshot.png', visibility: 'PUBLIC' }]);
    await client.exec(`INSERT INTO comments (ticket_id, author_id, text) VALUES (10, 'u-agent', 'new note')`);
    expect((await q(client, `SELECT visibility FROM comments WHERE text = 'new note'`))[0].visibility).toBe('INTERNAL');
  });

  it('new constraints hold: same-organization contacts and assignees, unique numbers, one active tracking link', async () => {
    const fails = async (sql: string) => expect(client.exec(sql)).rejects.toThrow();
    const globexContact = (await q(client, `SELECT contact_id FROM contacts WHERE tenant_id = 'globex'`))[0].contact_id;
    await fails(`UPDATE tickets SET contact_id = ${globexContact} WHERE ticket_id = 10`); // contact of another org
    await fails(`UPDATE tickets SET assignee_id = 'u-cust1' WHERE ticket_id = 10`); // not a member
    await fails(`UPDATE tickets SET ticket_number = 2 WHERE ticket_id = 10`); // duplicate number
    await fails(`INSERT INTO comments (ticket_id, text) VALUES (10, 'nobody')`); // needs an author
    await fails(`INSERT INTO ticket_tracking_tokens (tenant_id, ticket_id, token_hash, expires_at, created_by) VALUES ('globex', 10, 'h', now(), 'u-agent')`); // wrong org
    await client.exec(`INSERT INTO ticket_tracking_tokens (tenant_id, ticket_id, token_hash, expires_at, created_by) VALUES ('acme', 10, 'h1', now(), 'u-agent')`);
    await fails(`INSERT INTO ticket_tracking_tokens (tenant_id, ticket_id, token_hash, expires_at, created_by) VALUES ('acme', 10, 'h2', now(), 'u-agent')`);
  });

  it('history stays reachable through the API for staff; numbering continues; legacy customer logins have no access', async () => {
    const db = drizzle(client, { schema }) as unknown as Database;
    const { app } = await buildApp({ env: testEnv, db, emailSender: new RecordingEmailSender(), storage: new InMemoryStorageService(), logger: false });
    await app.ready();
    const api = makeClient(app);
    // sessions for first-version accounts (their passwords are not part of this fixture)
    const future = new Date(Date.now() + 3600_000).toISOString();
    await client.exec(`
      INSERT INTO session (id, token, user_id, expires_at) VALUES
        ('s1', 'legacy-admin-token', 'u-admin', '${future}'), ('s2', 'legacy-customer-token', 'u-cust1', '${future}');
    `);
    const admin = { token: 'legacy-admin-token', userId: 'u-admin', orgId: 'acme' };

    const list = await api.call('GET', '/tickets?order=asc', admin);
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: any) => [x.ticketNumber, x.contactName])).toEqual([[1, 'Amina Customer'], [2, 'Amina Customer'], [3, 'Kevin Customer']]);
    const comments = await api.call('GET', '/tickets/11/comments', admin);
    expect(comments.body.items.map((c: any) => [c.text, c.authorRole])).toEqual([['Any update?', 'CUSTOMER'], ['Fixed now.', 'AGENT']]);
    expect((await api.call('GET', '/tickets/11/attachments', admin)).body).toHaveLength(1);

    const contact = list.body.items[0].contactId;
    const created = await api.call('POST', '/tickets', admin, { contactId: contact, title: 'Follow-up', description: 'Phone call', channel: 'PHONE' });
    expect(created.body.ticketNumber).toBe(4);

    expect((await api.call('GET', '/tickets', { token: 'legacy-customer-token', userId: 'u-cust1', orgId: 'acme' })).status).toBe(403);
    await app.close();
  });
});
