import type { FastifyInstance } from 'fastify';
import type { AuthUser } from '../auth/auth-user.js'
import { idParam, userIdParam } from '../dto/common.dto.js';
import { auditQuery, createUserDto, listUsersQuery } from '../dto/user.dto.js';
import type { AuditService } from '../service/audit.service.js';
import type { UserService } from '../service/user.service.js';
import { currentUser } from '../auth/plugin.js';

export function userController(app: FastifyInstance, users: UserService, audit: AuditService) {
  const { requireAuth, verifyRole } = app;
  app.get('/users',     { preHandler: [requireAuth, verifyRole(['AGENT', 'ADMIN'])] }, (req) => users.listUsers(currentUser(req), listUsersQuery.parse(req.query)));
  app.get('/users/:id', { preHandler: [requireAuth, verifyRole(['CUSTOMER', 'AGENT', 'ADMIN'])] }, (req) => users.getUserById(currentUser(req), userIdParam.parse(req.params).id));
  app.post('/users',    { preHandler: [requireAuth, verifyRole(['ADMIN'])] }, async (req, reply) => {
  const user = await users.createUser(currentUser(req), createUserDto.parse(req.body));
  return reply.code(201).send(user);
});

  // Audit logs (who did what and when): admin only
  app.get('/audit-logs', { preHandler: [requireAuth, verifyRole(['ADMIN'])] }, (req) => audit.list(currentUser(req), auditQuery.parse(req.query)));
}
