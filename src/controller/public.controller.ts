import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TenantService } from '../service/tenant.service.js';

const slugParam = z.object({ slug: z.string().trim().toLowerCase().min(1).max(64) });

/** Unauthenticated routes. Keep this surface tiny. */
export function publicController(app: FastifyInstance, tenants: TenantService) {
  app.get('/public/tenants/:slug', (req) => tenants.getPublicInfo(slugParam.parse(req.params).slug));
}