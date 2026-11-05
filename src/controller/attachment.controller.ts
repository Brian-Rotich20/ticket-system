import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/plugin.js';
import { idParam } from '../dto/common.dto.js';
import { ValidationError } from '../exception/errors.js';
import type { AttachmentService } from '../service/attachment.service.js';

export function attachmentController(app: FastifyInstance, attachments: AttachmentService) {
  const anyone = { preHandler: [app.requireAuth, app.verifyRole(['CUSTOMER', 'AGENT', 'ADMIN'])] };

  // multipart/form-data with a single "file" field
  app.post('/tickets/:id/attachments', anyone, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const part = await req.file();
    if (!part) throw new ValidationError('Send the file as multipart/form-data');
    const data = await part.toBuffer(); // throws FST_REQ_FILE_TOO_LARGE past the size limit
    const saved = await attachments.uploadFile(currentUser(req), id, { filename: part.filename, mimetype: part.mimetype, data });
    return reply.code(201).send(saved);
  });

  app.get('/tickets/:id/attachments', anyone, (req) =>
    attachments.getAttachmentsByTicketId(currentUser(req), idParam.parse(req.params).id),
  );

  app.get('/attachments/:id', anyone, (req) => attachments.getFileUrl(currentUser(req), idParam.parse(req.params).id));

  app.get('/attachments/:id/download', anyone, async (req, reply) => {
    const { attachment, data } = await attachments.readFile(currentUser(req), idParam.parse(req.params).id);
    return reply
      .header('Content-Type', attachment.fileType)
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .send(data);
  });

  app.delete('/attachments/:id', anyone, async (req, reply) => {
    await attachments.deleteAttachment(currentUser(req), idParam.parse(req.params).id);
    return reply.code(204).send();
  });
}