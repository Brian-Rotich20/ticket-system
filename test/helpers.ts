import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/config/db.js';
import type { Env } from '../src/config/env.js';
import * as schema from '../src/model/schema.js';
import { hashPassword } from '../src/service/password.js';
import type { EmailMessage, EmailSender } from '../src/service/email.service.js';
import { InMemoryStorageService } from '../src/service/storage.service.js';

export class RecordingEmailSender implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
  }
}

export const testEnv: Env = {
  NODE_ENV: 'test', PORT: 0, HOST: '127.0.0.1', DATABASE_URL: 'unused',
  JWT_SECRET: 'test-secret-test-secret-test-secret-123', JWT_EXPIRES_IN: '1h',
  UPLOAD_DIR: './uploads-test', MAX_UPLOAD_BYTES: 1024 * 1024, MAX_ATTACHMENTS_PER_TICKET: 2,
};

export async function createTestApp() {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as any, { migrationsFolder: './drizzle' });
  const email = new RecordingEmailSender();
  const storage = new InMemoryStorageService();
  const { app, services } = await buildApp({ env: testEnv, db, emailSender: email, storage, logger: false });
  await app.ready();

  const adminPw = 'admin-password';
  await db.insert(schema.users).values({ name: 'Admin', email: 'admin@x.com', role: 'ADMIN', passwordHash: await hashPassword(adminPw) });

  const api = makeClient(app);
  const admin = await api.login('admin@x.com', adminPw);
  return { app, db, email, storage, services, api, admin, close: async () => { await app.close(); await client.close(); } };
}

export function makeClient(app: FastifyInstance) {
  const call = async (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: method as any, url, payload: payload as any,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    let body: any = undefined;
    try { body = res.body ? JSON.parse(res.body) : undefined; } catch { body = res.body; }
    return { status: res.statusCode, body, raw: res };
  };
  return {
    call,
    async register(name: string, email: string, password = 'password123') {
      const r = await call('POST', '/auth/register', undefined, { name, email, password });
      return { token: r.body.token as string, userId: r.body.user.userId as number };
    },
    async login(email: string, password: string) {
      const r = await call('POST', '/auth/login', undefined, { email, password });
      return { token: r.body.token as string, userId: r.body.user.userId as number };
    },
    upload(ticketId: number, token: string, filename: string, mime: string, data: Buffer) {
      const boundary = '----tstboundary';
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return call('POST', `/tickets/${ticketId}/attachments`, token, body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    },
  };
}
