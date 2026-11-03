import type { FastifyInstance } from 'fastify';
import { actorOf } from '../auth/auth.js';
import { idParam } from '../dto/common.dto.js';
import { auditQuery, createUserDto, listUsersQuery } from '../dto/user.dto.js';
import type { AuditService } from '../service/audit.service.js';
import type { UserService } from '../service/user.service.js';

export function userController(app: FastifyInstance, users: UserService, audit: AuditService) {
  const auth = { preHandler: app.authenticate };

  app.get('/users', auth, (req) => users.listUsers(actorOf(req), listUsersQuery.parse(req.query)));
  app.get('/users/:id', auth, (req) => users.getUserById(actorOf(req), idParam.parse(req.params).id));

  app.post('/users', auth, async (req, reply) => {
    const user = await users.createUser(actorOf(req), createUserDto.parse(req.body));
    return reply.code(201).send(user);
  });

  // Audit logs (who did what and when): admin only
  app.get('/audit-logs', auth, (req) => audit.list(actorOf(req), auditQuery.parse(req.query)));
}
