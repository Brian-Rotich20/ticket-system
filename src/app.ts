import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { createAuth, type Auth } from './auth/auth.js';
import { registerAuth } from './auth/plugin.js';
import { API_PREFIX } from './config/constants.js';
import type { Database } from './config/db.js';
import type { Env } from './config/env.js';
import { attachmentController } from './controller/attachment.controller.js';
import { authController } from './controller/auth.controller.js';
import { contactController } from './controller/contact.controller.js';
import { organizationController } from './controller/organization.controller.js';
import { ticketController } from './controller/ticket.controller.js';
import { userController } from './controller/user.controller.js';
import { AppError, isForeignKeyViolation } from './exception/errors.js';
import { AttachmentRepository } from './repository/attachment.repository.js';
import { AuditRepository } from './repository/audit.repository.js';
import { CommentRepository } from './repository/comment.repository.js';
import { ContactRepository } from './repository/contact.repository.js';
import { InvitationRepository } from './repository/invitation.repository.js';
import { MemberRepository } from './repository/member.repository.js';
import { TicketRepository } from './repository/ticket.repository.js';
import { TrackingTokenRepository } from './repository/tracking.repository.js';
import { UserRepository } from './repository/user.repository.js';
import { AttachmentService, type FileScanner } from './service/attachment.service.js';
import { AuditService } from './service/audit.service.js';
import { CommentService } from './service/comment.service.js';
import { ContactService } from './service/contact.service.js';
import { DashboardService } from './service/dashboard.service.js';
import { LogEmailSender, type EmailSender } from './service/email.service.js';
import { InvitationService } from './service/invitation.service.js';
import { NotificationService } from './service/notification.service.js';
import { createStorage } from './service/storage.factory.js';
import type { StorageService } from './service/storage.service.js';
import { TicketService } from './service/ticket.service.js';
import { TrackingService } from './service/tracking.service.js';
import { UserService } from './service/user.service.js';
import { publicController } from './controller/public.controller.js';
import { TenantRepository } from './repository/tenant.repository.js';
import { TenantService } from './service/tenant.service.js';
import cors from '@fastify/cors';
import { parseOrigins } from './config/env.js';

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

/** Tracking and invitation tokens are bearer secrets: they never reach the logs. */
export const redactUrl = (url: string) => url.replace(/\/public\/(tickets|invitations)\/[^/?#]+/g, '/public/$1/[redacted]');

export async function buildApp(deps: AppDeps) {
  const { env, db } = deps;
  const logEnabled = deps.logger ?? env.NODE_ENV !== 'test';
  const app = Fastify({
    logger: logEnabled
      ? {
          serializers: {
            req: (req: FastifyRequest) => ({ method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip }),
          },
        }
      : false,
    bodyLimit: 1024 * 1024,
    // behind Render's proxy the client IP is in X-Forwarded-For; rate limiting keys on it
    trustProxy: env.TRUST_PROXY_HOPS > 0 ? (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS : false,
  });
  const allowedOrigins = new Set(parseOrigins(env.TRUSTED_ORIGINS)); //CORS
  // --- composition root: repositories -> services -> controllers ---
  const auth = deps.auth ?? createAuth(db, env);

  const userRepo = new UserRepository(db);
  const memberRepo = new MemberRepository(db);
  const tenantRepo = new TenantRepository(db);
  const invitationRepo = new InvitationRepository(db);
  const contactRepo = new ContactRepository(db);
  const ticketRepo = new TicketRepository(db);
  const commentRepo = new CommentRepository(db);
  const attachmentRepo = new AttachmentRepository(db);
  const trackingRepo = new TrackingTokenRepository(db);
  const auditRepo = new AuditRepository(db);

  const audit = new AuditService(auditRepo);
  const notifier = new NotificationService(memberRepo, deps.emailSender ?? new LogEmailSender(app.log), app.log);
  const storage = deps.storage ?? createStorage(env);

  const userService = new UserService(db, userRepo, memberRepo, audit, auth);
  const tenantService = new TenantService(db, tenantRepo, memberRepo, userService, audit);
  const invitationService = new InvitationService(db, invitationRepo, memberRepo, tenantRepo, userRepo, userService, audit, notifier, {
    ttlDays: env.INVITATION_TTL_DAYS,
    appUrl: env.APP_URL,
  });
  const contactService = new ContactService(db, contactRepo, ticketRepo, audit);
  const ticketService = new TicketService(db, ticketRepo, memberRepo, contactService, audit, notifier);
  const commentService = new CommentService(db, commentRepo, ticketRepo, audit, notifier);
  const attachmentService = new AttachmentService(db, attachmentRepo, ticketRepo, commentRepo, storage, audit, {
    maxBytes: env.MAX_UPLOAD_BYTES,
    maxPerTicket: env.MAX_ATTACHMENTS_PER_TICKET,
    scan: deps.scanner,
  });
  const trackingService = new TrackingService(db, trackingRepo, ticketRepo, tenantRepo, commentRepo, commentService, attachmentService, audit, {
    ttlDays: env.TRACKING_TOKEN_TTL_DAYS,
    appUrl: env.APP_URL,
  });
  const dashboardService = new DashboardService(ticketRepo);


    await app.register(cors, {
      origin: (origin, cb) => {
        if (!origin || allowedOrigins.has(origin)) {
          return cb(null, true);
        }

        return cb(new Error('Origin not allowed'), false);
      },

      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Organization-Id'],
      exposedHeaders: ['set-auth-token'],
      maxAge: 86400,
    });

  // only routes that opt in (config.rateLimit) are limited: public tracking / invitation routes and registration
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: { code: 'RATE_LIMITED', message: `Too many requests. Try again in ${ctx.after}.` },
    }),
  });

  // Better Auth at /api/auth/* + requireSession / requireAuth / verifyRole hooks (registered on the root instance)
  await registerAuth(app, auth, env.BETTER_AUTH_URL, memberRepo);
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
    if (err?.statusCode === 429 && err?.error) return reply.code(429).send({ error: err.error }); // rate limiter
    if (typeof err?.statusCode === 'number' && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));

  app.get('/health', async () => ({ status: 'ok' })); // unprefixed

  // business owner registration, next to Better Auth's routes
  authController(app, tenantService);

  // every business route lives under /api/v1
  await app.register(
    async (api) => {
      userController(api, userService, audit);
      organizationController(api, tenantService, invitationService, dashboardService);
      contactController(api, contactService);
      ticketController(api, ticketService, commentService, trackingService);
      attachmentController(api, attachmentService);
      publicController(api, tenantService, trackingService, invitationService);
    },
    { prefix: API_PREFIX },
  );

  return {
    app,
    auth,
    services: { userService, tenantService, invitationService, contactService, ticketService, commentService, attachmentService, trackingService, notifier },
  };
}
