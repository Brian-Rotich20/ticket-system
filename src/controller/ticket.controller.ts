import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/plugin.js';
import { createCommentDto } from '../dto/comment.dto.js';
import { idParam, paginationQuery } from '../dto/common.dto.js';
import { createTicketDto, ticketFilterQuery, ticketSearchQuery, updateTicketDto } from '../dto/ticket.dto.js';
import type { MemberRole } from '../model/enums.js';
import type { CommentService } from '../service/comment.service.js';
import type { TicketService } from '../service/ticket.service.js';
import type { TrackingService } from '../service/tracking.service.js';

const STAFF: MemberRole[] = ['AGENT', 'ADMIN'];

/** Controllers validate the request and delegate. Workflow rules live in the service, ownership rules in policy.ts. */
export function ticketController(app: FastifyInstance, tickets: TicketService, comments: CommentService, tracking: TrackingService) {
  const { requireAuth, verifyRole } = app;
  const staff = { preHandler: [requireAuth, verifyRole(STAFF)] };

  // tickets are recorded by staff on behalf of a contact
  app.post('/tickets', staff, async (req, reply) => {
    const ticket = await tickets.createTicket(currentUser(req), createTicketDto.parse(req.body));
    return reply.code(201).send(ticket);
  });

  app.get('/tickets', staff, (req) => tickets.getTickets(currentUser(req), ticketFilterQuery.parse(req.query)));

  // static routes are matched before /tickets/:id
  app.get('/tickets/search', staff, (req) => tickets.searchTickets(currentUser(req), ticketSearchQuery.parse(req.query)));
  app.get('/tickets/my', staff, (req) => tickets.getMyTickets(currentUser(req), ticketFilterQuery.parse(req.query)));

  app.get('/tickets/:id', staff, (req) => tickets.getTicketById(currentUser(req), idParam.parse(req.params).id));

  app.patch('/tickets/:id', staff, (req) =>
    tickets.updateTicket(currentUser(req), idParam.parse(req.params).id, updateTicketDto.parse(req.body)),
  );

  app.post('/tickets/:id/comments', staff, async (req, reply) => {
    const comment = await comments.addComment(currentUser(req), idParam.parse(req.params).id, createCommentDto.parse(req.body));
    return reply.code(201).send(comment);
  });

  app.get('/tickets/:id/comments', staff, (req) =>
    comments.getCommentsByTicketId(currentUser(req), idParam.parse(req.params).id, paginationQuery.parse(req.query)),
  );

  app.delete('/comments/:id', staff, async (req, reply) => {
    await comments.deleteComment(currentUser(req), idParam.parse(req.params).id);
    return reply.code(204).send();
  });

  // customer tracking link: the token is in this response only, never again
  app.post('/tickets/:id/tracking-link', staff, async (req, reply) => {
    const link = await tracking.createLink(currentUser(req), idParam.parse(req.params).id);
    return reply.code(201).header('Cache-Control', 'no-store').send(link);
  });
  app.get('/tickets/:id/tracking-link', staff, (req) => tracking.getLinkStatus(currentUser(req), idParam.parse(req.params).id));
  app.post('/tickets/:id/tracking-link/revoke', staff, async (req, reply) => {
    await tracking.revokeLink(currentUser(req), idParam.parse(req.params).id);
    return reply.code(204).send();
  });
}
