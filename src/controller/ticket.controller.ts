import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/plugin.js';
import { createCommentDto } from '../dto/comment.dto.js';
import { idParam, paginationQuery } from '../dto/common.dto.js';
import { createTicketDto, ticketFilterQuery, ticketSearchQuery, updateTicketDto } from '../dto/ticket.dto.js';
import type { UserRole } from '../model/enums.js';
import type { CommentService } from '../service/comment.service.js';
import type { TicketService } from '../service/ticket.service.js';

const ALL_ROLES: UserRole[] = ['CUSTOMER', 'AGENT', 'ADMIN'];
const STAFF: UserRole[] = ['AGENT', 'ADMIN'];

/** Controllers validate the request and delegate. Workflow rules live in the service, ownership rules in policy.ts. */
export function ticketController(app: FastifyInstance, tickets: TicketService, comments: CommentService) {
  const { requireAuth, verifyRole } = app;
  const anyone = { preHandler: [requireAuth, verifyRole(ALL_ROLES)] };

  app.post('/tickets', anyone, async (req, reply) => {
    const ticket = await tickets.createTicket(currentUser(req), createTicketDto.parse(req.body));
    return reply.code(201).send(ticket);
  });

  app.get('/tickets', anyone, (req) => tickets.getTickets(currentUser(req), ticketFilterQuery.parse(req.query)));

  // static routes are matched before /tickets/:id
  app.get('/tickets/search', anyone, (req) => tickets.searchTickets(currentUser(req), ticketSearchQuery.parse(req.query)));
  app.get('/tickets/my', anyone, (req) => tickets.getMyTickets(currentUser(req), ticketFilterQuery.parse(req.query)));

  app.get('/tickets/:id', anyone, (req) => tickets.getTicketById(currentUser(req), idParam.parse(req.params).id));

  // only agents and admins update status / priority / type / assignment
  app.patch('/tickets/:id', { preHandler: [requireAuth, verifyRole(STAFF)] }, (req) =>
    tickets.updateTicket(currentUser(req), idParam.parse(req.params).id, updateTicketDto.parse(req.body)),
  );

  app.post('/tickets/:id/comments', anyone, async (req, reply) => {
    const comment = await comments.addComment(currentUser(req), idParam.parse(req.params).id, createCommentDto.parse(req.body));
    return reply.code(201).send(comment);
  });

  app.get('/tickets/:id/comments', anyone, (req) =>
    comments.getCommentsByTicketId(currentUser(req), idParam.parse(req.params).id, paginationQuery.parse(req.query)),
  );

  app.delete('/comments/:id', anyone, async (req, reply) => {
    await comments.deleteComment(currentUser(req), idParam.parse(req.params).id);
    return reply.code(204).send();
  });
}