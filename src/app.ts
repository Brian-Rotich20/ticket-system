import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { createAuth, type Auth } from './auth/auth.js';
import { registerAuth } from './auth/plugin.js';
import { API_PREFIX } from './config/constants.js';
import type { Database } from './config/db.js';
import type { Env } from './config/env.js';
import { attachmentController } from './controller/attachment.controller.js';
import { ticketController } from './controller/ticket.controller.js';
import { userController } from './controller/user.controller.js';
import { AppError, isForeignKeyViolation } from './exception/errors.js';
import { AttachmentRepository } from './repository/attachment.repository.js';
import { AuditRepository } from './repository/audit.repository.js';
import { CommentRepository } from './repository/comment.repository.js';
import { TicketRepository } from './repository/ticket.repository.js';
import { UserRepository } from './repository/user.repository.js';
import { AttachmentService, type FileScanner } from './service/attachment.service.js';
import { AuditService } from './service/audit.service.js';
import { CommentService } from './service/comment.service.js';
import { LogEmailSender, type EmailSender } from './service/email.service.js';
import { NotificationService } from './service/notification.service.js';
import { createStorage } from './service/storage.factory.js';
import type { StorageService } from './service/storage.service.js';
import { TicketService } from './service/ticket.service.js';
import { UserService } from './service/user.service.js';

export interface AppDeps {
  env: Env;
  db: Database;
  /** The rest is overridable (tests). */
  auth?: Auth;
  emailSender?: EmailSender;
  storage?: StorageService;
  scanner?: FileScanner;
  logger?: boolean;
}

export async function buildApp(deps: AppDeps) {
  const { env, db } = deps;
  const app = Fastify({ logger: deps.logger ?? env.NODE_ENV !== 'test', bodyLimit: 1024 * 1024 });

  // --- composition root: repositories -> services -> controllers ---
  const auth = deps.auth ?? createAuth(db, env);

  const userRepo = new UserRepository(db);
  const ticketRepo = new TicketRepository(db);
  const commentRepo = new CommentRepository(db);
  const attachmentRepo = new AttachmentRepository(db);
  const auditRepo = new AuditRepository(db);

  const audit = new AuditService(auditRepo);
  const notifier = new NotificationService(userRepo, deps.emailSender ?? new LogEmailSender(app.log), app.log);
  const storage = deps.storage ?? createStorage(env);

  const userService = new UserService(db, userRepo, audit, auth);
  const ticketService = new TicketService(db, ticketRepo, userRepo, audit, notifier);
  const commentService = new CommentService(db, commentRepo, ticketRepo, audit, notifier);
  const attachmentService = new AttachmentService(db, attachmentRepo, ticketRepo, storage, audit, {
    maxBytes: env.MAX_UPLOAD_BYTES,
    maxPerTicket: env.MAX_ATTACHMENTS_PER_TICKET,
    scan: deps.scanner,
  });

  // Better Auth at /api/auth/* + requireAuth / verifyRole hooks (registered on the root instance)
  await registerAuth(app, auth, env.BETTER_AUTH_URL);
  await app.register(multipart, { limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1, fields: 5 } });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: { code: 'FILE_TOO_LARGE', message: `File exceeds the maximum size of ${env.MAX_UPLOAD_BYTES} bytes` } });
    }
    if (isForeignKeyViolation(err)) {
      return reply.code(409).send({ error: { code: 'CONFLICT', message: 'Referenced record no longer exists' } });
    }
    if (typeof err?.statusCode === 'number' && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));

  app.get('/health', async () => ({ status: 'ok' })); // unprefixed

  // every business route lives under /api/v1
  await app.register(
    async (api) => {
      userController(api, userService, audit);
      ticketController(api, ticketService, commentService);
      attachmentController(api, attachmentService);
    },
    { prefix: API_PREFIX },
  );

  return { app, auth, services: { userService, ticketService, commentService, attachmentService, notifier } };
}