import type { FastifyInstance } from 'fastify';
import { currentSessionUser, currentUser } from '../auth/plugin.js';
import { idParam, paginationQuery } from '../dto/common.dto.js';
import { createInvitationDto, updateOrganizationDto } from '../dto/organization.dto.js';
import type { DashboardService } from '../service/dashboard.service.js';
import type { InvitationService } from '../service/invitation.service.js';
import type { TenantService } from '../service/tenant.service.js';

/** Organization profile, invitations and dashboard. */
export function organizationController(
  app: FastifyInstance,
  organizations: TenantService,
  invitations: InvitationService,
  dashboard: DashboardService,
) {
  const { requireSession, requireAuth, verifyRole } = app;
  const staff = { preHandler: [requireAuth, verifyRole(['AGENT', 'ADMIN'])] };
  const admin = { preHandler: [requireAuth, verifyRole(['ADMIN'])] };

  // the organizations the signed-in user can act in: no X-Organization-Id needed (the client picks one from here)
  app.get('/organizations', { preHandler: [requireSession] }, (req) => organizations.listMine(currentSessionUser(req).id));

  app.get('/organizations/current', staff, (req) => organizations.getCurrent(currentUser(req)));
  app.patch('/organizations/current', admin, (req) =>
    organizations.updateCurrent(currentUser(req), updateOrganizationDto.parse(req.body)),
  );

  app.get('/invitations', admin, (req) => invitations.listInvitations(currentUser(req), paginationQuery.parse(req.query)));
  // the acceptance link (token) is in this response only, never again
  app.post('/invitations', admin, async (req, reply) => {
    const created = await invitations.createInvitation(currentUser(req), createInvitationDto.parse(req.body));
    return reply.code(201).header('Cache-Control', 'no-store').send(created);
  });
  app.post('/invitations/:id/revoke', admin, async (req, reply) => {
    await invitations.revokeInvitation(currentUser(req), idParam.parse(req.params).id);
    return reply.code(204).send();
  });

  app.get('/dashboard/overview', staff, (req) => dashboard.overview(currentUser(req)));
}
