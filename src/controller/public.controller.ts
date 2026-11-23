import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forwardAuthHeaders } from '../auth/plugin.js';
import { publicCommentDto } from '../dto/comment.dto.js';
import { acceptInvitationDto, tokenParam } from '../dto/organization.dto.js';
import type { InvitationService } from '../service/invitation.service.js';
import type { TenantService } from '../service/tenant.service.js';
import type { TrackingService } from '../service/tracking.service.js';

const slugParam = z.object({ slug: z.string().trim().toLowerCase().min(1).max(64) });
const tokenAttachmentParam = tokenParam.extend({ attachmentId: z.coerce.number().int().positive() });

/** Per client IP. Generous for a person, tight for anyone guessing tokens. */
const READ_LIMIT = { rateLimit: { max: 60, timeWindow: '1 minute' } };
const WRITE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/**
 * Unauthenticated routes. Keep this surface tiny. Tracking and invitation routes are authorised by their token
 * alone (validated in the service, independently of staff sessions), rate limited, and never cached.
 */
export function publicController(app: FastifyInstance, tenants: TenantService, tracking: TrackingService, invitations: InvitationService) {
  app.get('/public/tenants/:slug', (req) => tenants.getPublicInfo(slugParam.parse(req.params).slug));

  app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Robots-Tag', 'noindex, nofollow');
    });

    // ---- customer ticket tracking
    scope.get('/public/tickets/:token', { config: READ_LIMIT }, (req) => tracking.getPublicTicket(tokenParam.parse(req.params).token));

    scope.post('/public/tickets/:token/comments', { config: WRITE_LIMIT }, async (req, reply) => {
      const { token } = tokenParam.parse(req.params);
      const comment = await tracking.addPublicComment(token, publicCommentDto.parse(req.body).text);
      return reply.code(201).send(comment);
    });

    scope.get('/public/tickets/:token/attachments/:attachmentId', { config: READ_LIMIT }, async (req, reply) => {
      const { token, attachmentId } = tokenAttachmentParam.parse(req.params);
      const { attachment, data } = await tracking.readPublicAttachment(token, attachmentId);
      return reply
        .header('Content-Type', attachment.fileType)
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`)
        .header('X-Content-Type-Options', 'nosniff')
        .send(data);
    });

    // ---- staff invitations
    scope.get('/public/invitations/:token', { config: READ_LIMIT }, (req) =>
      invitations.getPublicInvitation(tokenParam.parse(req.params).token),
    );

    // signed in: joins with the current account; otherwise creates an account (name + password) and signs it in
    scope.post('/public/invitations/:token/accept', { config: WRITE_LIMIT, preHandler: [scope.optionalSession] }, async (req, reply) => {
      const { token } = tokenParam.parse(req.params);
      const { headers, body } = await invitations.acceptInvitation(token, req.sessionUser, acceptInvitationDto.parse(req.body ?? {}));
      if (headers) forwardAuthHeaders(headers, reply);
      return reply.code(200).send(body);
    });
  });
}
