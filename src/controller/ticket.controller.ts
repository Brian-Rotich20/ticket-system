import type { FastifyInstance } from 'fastify';
import { createCommentDto } from '../dto/comment.dto.js';
import { idParam, paginationQuery } from '../dto/common.dto.js';
import { createTicketDto, ticketFilterQuery, ticketSearchQuery, updateTicketDto } from '../dto/ticket.dto.js';
import { actorOf } from '../auth/auth.js';
import type { CommentService } from '../service/comment.service.js';
import type { TicketService } from '../service/ticket.service.js';

/** Controllers only validate the request and delegate to a service. Workflow rules live in the service layer. */
export function ticketController(app: FastifyInstance, tickets: TicketService, comments: CommentService) {
  const auth = { preHandler: app.authenticate };

  app.post('/tickets', auth, async (req, reply) => {
    const ticket = await tickets.createTicket(actorOf(req), createTicketDto.parse(req.body));
    return reply.code(201).send(ticket);
  });

  app.get('/tickets', auth, (req) => tickets.getTickets(actorOf(req), ticketFilterQuery.parse(req.query)));

  // static routes are matched before /tickets/:id
  app.get('/tickets/search', auth, (req) => tickets.searchTickets(actorOf(req), ticketSearchQuery.parse(req.query)));
  app.get('/tickets/my', auth, (req) => tickets.getMyTickets(actorOf(req), ticketFilterQuery.parse(req.query)));

  app.get('/tickets/:id', auth, (req) => tickets.getTicketById(actorOf(req), idParam.parse(req.params).id));

  app.patch('/tickets/:id', auth, (req) =>
    tickets.updateTicket(actorOf(req), idParam.parse(req.params).id, updateTicketDto.parse(req.body)),
  );

  app.post('/tickets/:id/comments', auth, async (req, reply) => {
    const comment = await comments.addComment(actorOf(req), idParam.parse(req.params).id, createCommentDto.parse(req.body));
    return reply.code(201).send(comment);
  });

  app.get('/tickets/:id/comments', auth, (req) =>
    comments.getCommentsByTicketId(actorOf(req), idParam.parse(req.params).id, paginationQuery.parse(req.query)),
  );

  app.delete('/comments/:id', auth, async (req, reply) => {
    await comments.deleteComment(actorOf(req), idParam.parse(req.params).id);
    return reply.code(204).send();
  });
}
