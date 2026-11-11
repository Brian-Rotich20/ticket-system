import { eq } from 'drizzle-orm';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { bearer } from 'better-auth/plugins';
import type { Database } from '../config/db.js';
import type { Env } from '../config/env.js';
import { parseOrigins } from '../config/env.js';
import { accounts, sessions, tenants, users, verifications } from '../model/schema.js'; // adjust the path to your schema file

export type AuthEnv = Pick<Env, 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'TRUSTED_ORIGINS'>;

export function createAuth(db: Database, env: AuthEnv) {
  return betterAuth({
    appName: 'Support Tickets',
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: parseOrigins(env.TRUSTED_ORIGINS),

    // keys must be Better Auth's model names; your table names (users, sessions, ...) can differ
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),

    emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },

    user: {
      additionalFields: {
        // multi-tenant scope: required at sign-up
        tenantId: { type: 'string', required: true },
        // CUSTOMER | AGENT | ADMIN: never accepted from client input
        role: { type: 'string', required: false, defaultValue: 'CUSTOMER', input: false },
      },
    },

    databaseHooks: {
      user: {
        create: {
          // reject sign-ups for a tenant that doesn't exist
          before: async (user) => {
            const tenantId = (user as { tenantId?: string }).tenantId;
            const [tenant] = tenantId
              ? await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)
              : [];
            if (!tenant) throw new APIError('BAD_REQUEST', { message: 'Unknown tenant' });
            return { data: user };
          },
        },
      },
    },

    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    plugins: [bearer()], // lets API clients send `Authorization: Bearer <token>`; browsers use cookies
  });
}

export type Auth = ReturnType<typeof createAuth>;
