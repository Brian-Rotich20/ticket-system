import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../exception/errors.js';
import type { MemberRole } from '../model/enums.js';
import type { MemberRepository } from '../repository/member.repository.js';
import type { Auth } from './auth.js';
import type { AuthUser, SessionUser } from './auth-user.js';

/** Organization-scoped routes name the organization they act on with this header. */
export const ORGANIZATION_HEADER = 'x-organization-id';

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser: SessionUser | null; // set by requireSession / requireAuth
    user: AuthUser | null; // set by requireAuth
  }
  interface FastifyInstance {
    /** preHandler: 401 unless the request carries a valid Better Auth session. Sets request.sessionUser. */
    requireSession: (req: FastifyRequest) => Promise<void>;
    /** preHandler: sets request.sessionUser when a valid session is sent; 401 only for an invalid Bearer token. */
    optionalSession: (req: FastifyRequest) => Promise<void>;
    /**
     * preHandler: valid session AND an ACTIVE membership of the organization in the X-Organization-Id header.
     * Sets request.user (with the organization id and the member role). Checked on every request, so a
     * deactivated member loses access immediately.
     */
    requireAuth: (req: FastifyRequest) => Promise<void>;
    /** preHandler factory: 403 unless request.user.role is in allowedRoles. Use after requireAuth. */
    verifyRole: (allowedRoles: MemberRole[]) => (req: FastifyRequest) => Promise<void>;
  }
}

export const toWebHeaders = (h: IncomingHttpHeaders): Headers => {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
    else out.set(k, v);
  }
  return out;
};

/** The authenticated member of a protected, organization-scoped route (401 if requireAuth did not run). */
export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

/** The signed-in account of a route guarded by requireSession. */
export function currentSessionUser(req: FastifyRequest): SessionUser {
  if (!req.sessionUser) throw new UnauthorizedError();
  return req.sessionUser;
}

/** Copies a Better Auth response's headers (session token, cookies) onto a Fastify reply. */
export function forwardAuthHeaders(from: Headers, reply: { header: (k: string, v: unknown) => unknown }) {
  from.forEach((value, key) => {
    if (key !== 'set-cookie' && key !== 'content-length' && key !== 'content-type') reply.header(key, value);
  });
  const cookies = from.getSetCookie();
  if (cookies.length > 0) reply.header('set-cookie', cookies);
}

/** Better Auth routes that clients may not call directly. Accounts are created via /api/auth/register or an invitation. */
const BLOCKED_AUTH_PATHS = [/^\/api\/auth\/sign-up(\/|$)/];

/** Mounts Better Auth at /api/auth/* and installs the requireSession / requireAuth / verifyRole hooks. */
export async function registerAuth(app: FastifyInstance, auth: Auth, baseUrl: string, members: MemberRepository) {
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

  // Better Auth: sign-in, sign-out, get-session, ...
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const path = req.url.split('?')[0]!;
      if (BLOCKED_AUTH_PATHS.some((p) => p.test(path))) {
        return reply.code(403).send({ code: 'SIGN_UP_DISABLED', message: 'Self sign-up is disabled. Register a business at /api/auth/register or accept an invitation.' });
      }
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

  app.decorateRequest('sessionUser', null);
  app.decorateRequest('user', null);

  const resolveSession = async (req: FastifyRequest): Promise<SessionUser> => {
    if (req.sessionUser) return req.sessionUser;
    const session = await auth.api.getSession({ headers: toWebHeaders(req.headers) });
    if (!session) throw new UnauthorizedError('Invalid or missing session');
    const { id, email, name } = session.user;
    req.sessionUser = { id, email, name };
    return req.sessionUser;
  };

  app.decorate('requireSession', async (req: FastifyRequest) => {
    await resolveSession(req);
  });

  app.decorate('optionalSession', async (req: FastifyRequest) => {
    try {
      await resolveSession(req);
    } catch (err) {
      if (req.headers.authorization) throw err; // a stale cookie is ignored, a wrong bearer token is not
    }
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    const sessionUser = await resolveSession(req);
    const header = req.headers[ORGANIZATION_HEADER];
    const tenantId = typeof header === 'string' ? header.trim() : '';
    if (!tenantId || tenantId.length > 64) {
      throw new ValidationError('Send the organization id in the X-Organization-Id header');
    }
    const membership = await members.find(tenantId, sessionUser.id);
    if (!membership || membership.status !== 'ACTIVE') {
      throw new ForbiddenError('You are not an active member of this organization');
    }
    req.user = { ...sessionUser, tenantId, role: membership.role };
  });

  app.decorate('verifyRole', (allowedRoles: MemberRole[]) => async (req: FastifyRequest) => {
    if (!req.user) throw new UnauthorizedError();
    if (!allowedRoles.includes(req.user.role)) {
      throw new ForbiddenError(`Requires one of the roles: ${allowedRoles.join(', ')}`);
    }
  });
}
