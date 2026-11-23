import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import type { Database } from '../config/db.js';
import type { Env } from '../config/env.js';
import { parseOrigins } from '../config/env.js';
import { accounts, sessions, users, verifications } from '../model/schema.js';

export type AuthEnv = Pick<Env, 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'TRUSTED_ORIGINS'>;

/**
 * Better Auth owns identities, passwords and sessions only. Organization membership and roles live in
 * `organization_members` and are resolved per request (see plugin.ts), so no tenant or role travels on the user:
 * nothing a client can send to /api/auth/* (sign-up, update-user, ...) can change what it is allowed to access.
 */
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

    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    plugins: [bearer()], // lets API clients send `Authorization: Bearer <token>`; browsers use cookies
  });
}

export type Auth = ReturnType<typeof createAuth>;
