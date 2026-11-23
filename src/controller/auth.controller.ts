import type { FastifyInstance } from 'fastify';
import { forwardAuthHeaders } from '../auth/plugin.js';
import { registerDto } from '../dto/organization.dto.js';
import type { TenantService } from '../service/tenant.service.js';

/**
 * POST /api/auth/register: a business owner creates their account and organization and becomes its ADMIN.
 * Registered next to Better Auth's /api/auth/* routes (a static route wins over the wildcard). Signs the new
 * account in: the session token comes back in `set-auth-token`, exactly like sign-in.
 */
export function authController(app: FastifyInstance, organizations: TenantService) {
  app.post('/api/auth/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { headers, body } = await organizations.register(registerDto.parse(req.body));
    forwardAuthHeaders(headers, reply);
    return reply.code(201).send(body);
  });
}
