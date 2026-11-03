import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';
import { UnauthorizedError } from '../exception/errors.js';
import type { UserRole } from '../model/enums.js';
import type { Actor } from '../service/actor.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { userId: number; role: UserRole };
    user: { userId: number; role: UserRole };
  }
}
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest) => Promise<void>;
  }
}

export async function registerAuth(app: FastifyInstance, env: Pick<Env, 'JWT_SECRET' | 'JWT_EXPIRES_IN'>) {
  await app.register(fastifyJwt, { secret: env.JWT_SECRET, sign: { expiresIn: env.JWT_EXPIRES_IN } });
  app.decorate('authenticate', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw new UnauthorizedError('Invalid or missing token');
    }
  });
}

export const actorOf = (req: FastifyRequest): Actor => ({ userId: req.user.userId, role: req.user.role });
