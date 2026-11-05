import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Database } from '../config/db.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  TicketClosedError,
  UnsupportedFileTypeError,
  ValidationError,
} from '../exception/errors.js';
import type { Attachment } from '../model/schema.js';
import type { AttachmentRepository } from '../repository/attachment.repository.js';
import type { TicketRepository } from '../repository/ticket.repository.js';
import type { AuthUser } from '../auth/auth-user.js'
import type { AuditService } from './audit.service.js';
import { assertCanView, isAdmin } from './policy.js';
import type { StorageService } from './storage.service.js';

/** Allowed uploads: screenshots, logs, documents. mime -> permitted extensions. */
const ALLOWED: Record<string, readonly string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt', '.log'],
};

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};

export interface UploadedFile {
  filename: string;
  mimetype: string;
  data: Buffer;
}
export type AttachmentView = Attachment & { url: string };

/** Hook for antivirus scanning (ClamAV etc.). Throw to reject a file. */
export type FileScanner = (file: UploadedFile) => Promise<void>;

export class AttachmentService {
  constructor(
    private readonly db: Database,
    private readonly attachments: AttachmentRepository,
    private readonly tickets: TicketRepository,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly opts: { maxBytes: number; maxPerTicket: number; scan?: FileScanner },
  ) {}

  async uploadFile(actor: AuthUser, ticketId: number, file: UploadedFile): Promise<AttachmentView> {
    const fileName = this.validate(file);
    await this.opts.scan?.(file);
    const key = `tickets/${ticketId}/${randomUUID()}${path.extname(fileName).toLowerCase()}`;

    await this.storage.save(key, file.data, file.mimetype);
    try {
      const saved = await this.db.transaction(async (tx) => {
        const ticket = await this.tickets.findByIdForUpdate(ticketId, tx);
        if (!ticket) throw new NotFoundError('Ticket', ticketId);
        assertCanView(actor, ticket);
        if (ticket.status === 'CLOSED') throw new TicketClosedError(ticketId);
        if ((await this.attachments.countByTicket(ticketId, tx)) >= this.opts.maxPerTicket) {
          throw new ConflictError(`A ticket can have at most ${this.opts.maxPerTicket} attachments`, 'TOO_MANY_ATTACHMENTS');
        }
        const row = await this.attachments.insert(
          { ticketId, fileUrl: key, fileName, fileType: file.mimetype, uploadedBy: actor.id  },
          tx,
        );
        await this.audit.record({ actorId: actor.id, action: 'ATTACHMENT_ADDED', entityType: 'TICKET', entityId: ticketId, metadata: { attachmentId: row.attachmentId, fileName } }, tx);
        return row;
      });
      return this.toView(saved);
    } catch (err) {
      await this.storage.delete(key).catch(() => undefined); // don't leave orphaned files behind
      throw err;
    }
  }

  async getAttachmentsByTicketId(actor: AuthUser, ticketId: number): Promise<AttachmentView[]> {
    const ticket = await this.tickets.findById(ticketId);
    if (!ticket) throw new NotFoundError('Ticket', ticketId);
    assertCanView(actor, ticket);
    return Promise.all((await this.attachments.listByTicket(ticketId)).map((a) => this.toView(a)));
  }

  async getFileUrl(actor: AuthUser, attachmentId: number): Promise<AttachmentView> {
    return this.toView(await this.loadAuthorized(actor, attachmentId));
  }

  /** Authorised read used by the download endpoint when storage cannot hand out a signed URL. */
  async readFile(actor: AuthUser, attachmentId: number): Promise<{ attachment: Attachment; data: Buffer }> {
    const attachment = await this.loadAuthorized(actor, attachmentId);
    return { attachment, data: await this.storage.read(attachment.fileUrl) };
  }

  /** Uploader or admin only. */
  async deleteAttachment(actor: AuthUser, attachmentId: number): Promise<void> {
    const attachment = await this.loadAuthorized(actor, attachmentId);
    if (attachment.uploadedBy !== actor.id && !isAdmin(actor)) throw new ForbiddenError('Only the uploader or an admin can delete an attachment');
    await this.db.transaction(async (tx) => {
      await this.attachments.delete(attachmentId, tx);
      await this.audit.record({ actorId: actor.id, action: 'ATTACHMENT_DELETED', entityType: 'TICKET', entityId: attachment.ticketId, metadata: { attachmentId } }, tx);
    });
    await this.storage.delete(attachment.fileUrl).catch(() => undefined);
  }

  private async loadAuthorized(actor: AuthUser, attachmentId: number): Promise<Attachment> {
    const attachment = await this.attachments.findById(attachmentId);
    if (!attachment) throw new NotFoundError('Attachment', attachmentId);
    const ticket = await this.tickets.findById(attachment.ticketId);
    if (!ticket) throw new NotFoundError('Attachment', attachmentId);
    assertCanView(actor, ticket);
    return attachment;
  }

  private async toView(a: Attachment): Promise<AttachmentView> {
    const signed = await this.storage.getSignedUrl(a.fileUrl);
    return { ...a, url: signed ?? `/attachments/${a.attachmentId}/download` };
  }

  /** "File type and size should be validated." Returns the sanitised file name. */
  private validate(file: UploadedFile): string {
    if (file.data.length === 0) throw new ValidationError('File is empty');
    if (file.data.length > this.opts.maxBytes) throw new PayloadTooLargeError(this.opts.maxBytes);
    const exts = ALLOWED[file.mimetype];
    if (!exts) throw new UnsupportedFileTypeError(`File type ${file.mimetype} is not allowed. Allowed: ${Object.keys(ALLOWED).join(', ')}`);
    const name = path.basename(file.filename.replace(/\\/g, '/')).replace(/[^\w.\- ]+/g, '_').slice(-200) || 'file';
    if (!exts.includes(path.extname(name).toLowerCase())) {
      throw new UnsupportedFileTypeError(`File extension does not match type ${file.mimetype}`);
    }
    const magic = MAGIC[file.mimetype];
    if (magic && !magic(file.data)) throw new UnsupportedFileTypeError('File content does not match its declared type');
    return name;
  }
}
