import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { API_PREFIX } from '../src/config/constants.js';
import type { Database } from '../src/config/db.js';
import type { Env } from '../src/config/env.js';
import type { MemberRole } from '../src/model/enums.js';
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
  APP_URL: 'https://app.example.test',
  TRUST_PROXY_HOPS: 0,
  TRACKING_TOKEN_TTL_DAYS: 30,
  INVITATION_TTL_DAYS: 7,
  STORAGE_DRIVER: 'local',
  UPLOAD_DIR: './uploads-test',
  CLOUDINARY_FOLDER: 'test',
  MAX_UPLOAD_BYTES: 1024 * 1024,
  MAX_ATTACHMENTS_PER_TICKET: 2, // small on purpose: lets a test hit the limit
};

/** A signed-in account acting in one organization (orgId is sent as X-Organization-Id). */
export interface Session {
  token: string;
  userId: string;
  orgId?: string;
}

/** Business routes are called WITHOUT the /api/v1 prefix in tests; it is added here. Auth and health stay as given. */
const withPrefix = (url: string) => (url.startsWith('/api/auth') || url.startsWith('/health') ? url : `${API_PREFIX}${url}`);

export function makeClient(app: FastifyInstance) {
  let clientNo = 0;
  /** Each request comes from its own address unless one is given, so per-IP rate limits only bite where a test means them to. */
  const call = async (
    method: string,
    url: string,
    as?: Session | string,
    payload?: unknown,
    headers: Record<string, string> = {},
    remoteAddress = `10.${(++clientNo >> 16) & 255}.${(clientNo >> 8) & 255}.${clientNo & 255}`,
  ) => {
    const session = typeof as === 'string' ? { token: as, userId: '' } : as;
    const res = await app.inject({
      method: method as any,
      url: withPrefix(url),
      payload: payload as any,
      remoteAddress,
      headers: {
        ...(session?.token ? { authorization: `Bearer ${session.token}` } : {}),
        ...(session?.orgId ? { 'x-organization-id': session.orgId } : {}),
        ...headers,
      },
    });
    let body: any = undefined;
    try {
      body = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, raw: res };
  };

  const sessionFrom = (r: Awaited<ReturnType<typeof call>>, userId: string, orgId?: string): Session => ({
    token: r.raw.headers['set-auth-token'] as string,
    userId,
    orgId,
  });

  return {
    call,

    /** Business owner registration: account + organization + ADMIN membership. */
    async register(name: string, email: string, organizationName: string, password = 'password123'): Promise<Session> {
      const r = await call('POST', '/api/auth/register', undefined, { name, email, password, organizationName });
      if (r.status !== 201) throw new Error(`register failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
      return sessionFrom(r, r.body.user.id, r.body.organization.id);
    },

    async login(email: string, password: string, orgId?: string): Promise<Session> {
      const r = await call('POST', '/api/auth/sign-in/email', undefined, { email, password });
      if (r.status !== 200) throw new Error(`sign-in failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
      return sessionFrom(r, r.body.user.id, orgId);
    },

    /** Admin invites; returns the raw invitation token. */
    async invite(admin: Session, email: string, role: MemberRole = 'AGENT'): Promise<string> {
      const r = await call('POST', '/invitations', admin, { email, role });
      if (r.status !== 201) throw new Error(`invite failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.token as string;
    },

    /** Invite someone new and accept as them (creates their account). */
    async addMember(admin: Session, name: string, email: string, role: MemberRole = 'AGENT', password = 'password123'): Promise<Session> {
      const token = await this.invite(admin, email, role);
      const r = await call('POST', `/public/invitations/${token}/accept`, undefined, { name, password });
      if (r.status !== 200) throw new Error(`accept failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
      const login = await this.login(email, password, admin.orgId);
      return login;
    },

    /** multipart/form-data upload with a single `file` field. */
    upload(ticketId: number, as: Session, filename: string, mime: string, data: Buffer, query = '') {
      const boundary = '----tstboundary';
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return call('POST', `/tickets/${ticketId}/attachments${query}`, as, body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    },
  };
}

/** Fresh in-process Postgres (PGlite) with every migration applied. */
export async function createDatabase() {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as any, { migrationsFolder: './drizzle' });
  return { client, db };
}

/** Fresh database + app, with two registered businesses (each with its admin). */
export async function createTestApp() {
  const { client, db } = await createDatabase();
  const email = new RecordingEmailSender();
  const storage = new InMemoryStorageService();
  const { app, auth, services } = await buildApp({ env: testEnv, db, emailSender: email, storage, logger: false });
  await app.ready();
  const api = makeClient(app);

  const admin = await api.register('Acme Owner', 'owner@acme.com', 'Acme Store');
  const globexAdmin = await api.register('Globex Owner', 'owner@globex.com', 'Globex Shop');

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
