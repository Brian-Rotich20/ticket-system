import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/plugin.js';
import { idParam, paginationQuery } from '../dto/common.dto.js';
import { contactListQuery, createContactDto } from '../dto/contact.dto.js';
import type { ContactService } from '../service/contact.service.js';

export function contactController(app: FastifyInstance, contacts: ContactService) {
  const staff = { preHandler: [app.requireAuth, app.verifyRole(['AGENT', 'ADMIN'])] };

  app.get('/contacts', staff, (req) => contacts.listContacts(currentUser(req), contactListQuery.parse(req.query)));
  app.post('/contacts', staff, async (req, reply) => {
    const contact = await contacts.createContact(currentUser(req), createContactDto.parse(req.body));
    return reply.code(201).send(contact);
  });
  app.get('/contacts/:id', staff, (req) => contacts.getContact(currentUser(req), idParam.parse(req.params).id));
  app.get('/contacts/:id/tickets', staff, (req) =>
    contacts.getContactTickets(currentUser(req), idParam.parse(req.params).id, paginationQuery.parse(req.query)),
  );
}
