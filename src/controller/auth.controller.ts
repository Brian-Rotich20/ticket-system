import type { FastifyInstance } from 'fastify';
import { loginDto, registerDto } from '../dto/user.dto.js';
import type { UserService } from '../service/user.service.js';

export function authController(app: FastifyInstance, users: UserService) {
  app.post('/auth/register', async (req, reply) => {
    const user = await users.register(registerDto.parse(req.body));
    return reply.code(201).send({ user, token: app.jwt.sign({ userId: user.userId, role: user.role }) });
  });

  app.post('/auth/login', async (req) => {
    const user = await users.authenticate(loginDto.parse(req.body));
    return { user, token: app.jwt.sign({ userId: user.userId, role: user.role }) };
  });
}
