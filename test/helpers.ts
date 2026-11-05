import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { API_PREFIX } from '../src/config/constants.js';
import type { Database } from '../src/config/db.js';
import type { Env } from '../src/config/env.js';
import type { UserRole } from '../src/model/enums.js';
import * as schema from '../src/model/schema.js';
import type { EmailMessage, EmailSender } from '../src/service/email.service.js';
import { InMemoryStorageService } from '../src/service/storage.service.js';

export class RecordingEmailSender implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
  }
}

export const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 0,
  HOST: '127.0.0.1',
  DATABASE_URL: 'unused',
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
  BETTER_AUTH_URL: 'http://localhost:3000',
  TRUSTED_ORIGINS: '',
  STORAGE_DRIVER: 'local',
  UPLOAD_DIR: './uploads-test',
  CLOUDINARY_FOLDER: 'test',
  MAX_UPLOAD_BYTES: 1024 * 1024,
  MAX_ATTACHMENTS_PER_TICKET: 2, // small on purpose: lets a test hit the limit
};

export interface Session {
  token: string;
  userId: string;
}

/** Business routes are called WITHOUT the /api/v1 prefix in tests; it is added here. Auth and health stay as given. */
const withPrefix = (url: string) => (url.startsWith('/api/auth') || url.startsWith('/health') ? url : `${API_PREFIX}${url}`);

export function makeClient(app: FastifyInstance) {
  const call = async (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: method as any,
      url: withPrefix(url),
      payload: payload as any,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    let body: any = undefined;
    try {
      body = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, raw: res };
  };

  return {
    call,

    /** Better Auth sign-up. With the bearer plugin the session token comes back in the `set-auth-token` header. */
    async register(name: string, email: string, tenantId: string, password = 'password123'): Promise<Session> {
      const r = await call('POST', '/api/auth/sign-up/email', undefined, { name, email, password, tenantId });
      if (r.status !== 200) throw new Error(`sign-up failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
      return { token: r.raw.headers['set-auth-token'] as string, userId: r.body.user.id as string };
    },

    async login(email: string, password: string): Promise<Session> {
      const r = await call('POST', '/api/auth/sign-in/email', undefined, { email, password });
      if (r.status !== 200) throw new Error(`sign-in failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
      return { token: r.raw.headers['set-auth-token'] as string, userId: r.body.user.id as string };
    },

    /** An admin creates an agent (or another admin) in their own tenant, then we sign in as that user. */
    async createStaff(adminToken: string, name: string, email: string, role: UserRole, password = 'password123'): Promise<Session> {
      const r = await call('POST', '/users', adminToken, { name, email, password, role });
      if (r.status !== 201) throw new Error(`createStaff failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
      return this.login(email, password);
    },

    /** multipart/form-data upload with a single `file` field. */
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

/** Fresh in-process Postgres (PGlite) + migrations + two tenants, each with an admin. */
export async function createTestApp() {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as any, { migrationsFolder: './drizzle' });

  await db.insert(schema.tenants).values([
    { id: 'acme', name: 'Acme Store' },
    { id: 'globex', name: 'Globex Shop' },
  ]);

  const email = new RecordingEmailSender();
  const storage = new InMemoryStorageService();
  const { app, auth, services } = await buildApp({ env: testEnv, db, emailSender: email, storage, logger: false });
  await app.ready();
  const api = makeClient(app);

  // Same bootstrap as scripts/seed.ts: sign up through Better Auth, then raise the role on the server.
  const bootstrapAdmin = async (tenantId: string, address: string): Promise<Session> => {
    const s = await api.register('Admin', address, tenantId, 'admin-password');
    await db.update(schema.users).set({ role: 'ADMIN' }).where(eq(schema.users.id, s.userId));
    return s;
  };
  const admin = await bootstrapAdmin('acme', 'admin@acme.com');
  const globexAdmin = await bootstrapAdmin('globex', 'admin@globex.com');

  return {
    app,
    auth,
    db,
    email,
    storage,
    services,
    api,
    admin,
    globexAdmin,
    close: async () => {
      await app.close();
      await client.close();
    },
  };
}