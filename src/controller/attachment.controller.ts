import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth/plugin.js';
import { idParam } from '../dto/common.dto.js';
import { ValidationError } from '../exception/errors.js';
import { COMMENT_VISIBILITIES } from '../model/enums.js';
import type { AttachmentService } from '../service/attachment.service.js';

/** ?visibility=PUBLIC|INTERNAL (default INTERNAL) and/or ?commentId= (the attachment then takes the comment's visibility). */
const uploadQuery = z.object({
  visibility: z.enum(COMMENT_VISIBILITIES).optional(),
  commentId: z.coerce.number().int().positive().optional(),
});

export function attachmentController(app: FastifyInstance, attachments: AttachmentService) {
  const staff = { preHandler: [app.requireAuth, app.verifyRole(['AGENT', 'ADMIN'])] };

  // multipart/form-data with a single "file" field
  app.post('/tickets/:id/attachments', staff, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const options = uploadQuery.parse(req.query);
    const part = await req.file();
    if (!part) throw new ValidationError('Send the file as multipart/form-data');
    const data = await part.toBuffer(); // throws FST_REQ_FILE_TOO_LARGE past the size limit
    const saved = await attachments.uploadFile(currentUser(req), id, { filename: part.filename, mimetype: part.mimetype, data }, options);
    return reply.code(201).send(saved);
  });

  app.get('/tickets/:id/attachments', staff, (req) =>
    attachments.getAttachmentsByTicketId(currentUser(req), idParam.parse(req.params).id),
  );

  app.get('/attachments/:id', staff, (req) => attachments.getFileUrl(currentUser(req), idParam.parse(req.params).id));

  app.get('/attachments/:id/download', staff, async (req, reply) => {
    const { attachment, data } = await attachments.readFile(currentUser(req), idParam.parse(req.params).id);
    return reply
      .header('Content-Type', attachment.fileType)
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .send(data);
  });

  app.delete('/attachments/:id', staff, async (req, reply) => {
    await attachments.deleteAttachment(currentUser(req), idParam.parse(req.params).id);
    return reply.code(204).send();
  });
}
