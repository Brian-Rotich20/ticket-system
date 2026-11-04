import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { ForbiddenError, UnauthorizedError } from '../exception/errors.js';
import { USER_ROLES, type UserRole } from '../model/enums.js';
import type { Auth } from './auth.js';
import type { AuthUser } from './auth-user.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null; // set by requireAuth
  }
  interface FastifyInstance {
    /** preHandler: 401 unless the request carries a valid Better Auth session. Sets request.user. */
    requireAuth: (req: FastifyRequest) => Promise<void>;
    /** preHandler factory: 403 unless request.user.role is in allowedRoles. Use after requireAuth. */
    verifyRole: (allowedRoles: UserRole[]) => (req: FastifyRequest) => Promise<void>;
  }
}

const toWebHeaders = (h: IncomingHttpHeaders): Headers => {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
    else out.set(k, v);
  }
  return out;
};

/** The authenticated user of a protected route (401 if requireAuth did not run). */
export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

/** Mounts Better Auth at /api/auth/* and installs the requireAuth / verifyRole hooks. */
export async function registerAuth(app: FastifyInstance, auth: Auth, baseUrl: string) {
  // Accept empty JSON bodies (e.g. POST /api/auth/sign-out) instead of failing with a 400.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = new Error('Invalid JSON body') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Better Auth: sign-up, sign-in, sign-out, get-session, ...
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const response = await auth.handler(
        new Request(new URL(req.url, baseUrl), {
          method: req.method,
          headers: toWebHeaders(req.headers),
          body: req.body === undefined || req.body === null ? undefined : JSON.stringify(req.body),
        }),
      );
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie' && key !== 'content-length') reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
    },
  });

  app.decorateRequest('user', null);

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    const session = await auth.api.getSession({ headers: toWebHeaders(req.headers) });
    if (!session) throw new UnauthorizedError('Invalid or missing session');
    const { id, email, tenantId, role } = session.user as { id: string; email: string; tenantId?: string; role?: string };
    if (!tenantId || !role || !(USER_ROLES as readonly string[]).includes(role)) {
      throw new ForbiddenError('Account is missing a tenant or a valid role');
    }
    req.user = { id, email, tenantId, role: role as UserRole };
  });

  app.decorate('verifyRole', (allowedRoles: UserRole[]) => async (req: FastifyRequest) => {
    if (!req.user) throw new UnauthorizedError();
    if (!allowedRoles.includes(req.user.role)) {
      throw new ForbiddenError(`Requires one of the roles: ${allowedRoles.join(', ')}`);
    }
  });
}
