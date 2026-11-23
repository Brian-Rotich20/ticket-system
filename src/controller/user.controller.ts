import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/plugin.js';
import { userIdParam } from '../dto/common.dto.js';
import { auditQuery, createUserDto, listUsersQuery, updateMemberDto } from '../dto/user.dto.js';
import type { AuditService } from '../service/audit.service.js';
import type { UserService } from '../service/user.service.js';

/** /users is the organization's team: its members, with their role and status in this organization. */
export function userController(app: FastifyInstance, users: UserService, audit: AuditService) {
  const { requireAuth, verifyRole } = app;
  const staff = { preHandler: [requireAuth, verifyRole(['AGENT', 'ADMIN'])] };
  const admin = { preHandler: [requireAuth, verifyRole(['ADMIN'])] };

  app.get('/users', staff, (req) => users.listUsers(currentUser(req), listUsersQuery.parse(req.query)));
  app.get('/users/:id', staff, (req) => users.getUserById(currentUser(req), userIdParam.parse(req.params).id));
  app.post('/users', admin, async (req, reply) => {
    const user = await users.createUser(currentUser(req), createUserDto.parse(req.body));
    return reply.code(201).send(user);
  });
  // change role, deactivate / re-activate
  app.patch('/users/:id', admin, (req) =>
    users.updateMember(currentUser(req), userIdParam.parse(req.params).id, updateMemberDto.parse(req.body)),
  );

  // Audit logs (who did what and when): admin only
  app.get('/audit-logs', admin, (req) => audit.list(currentUser(req), auditQuery.parse(req.query)));
}
