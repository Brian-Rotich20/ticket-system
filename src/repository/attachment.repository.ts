import { asc, count, eq } from 'drizzle-orm';
import type { Database, Executor } from '../config/db.js';
import { attachments, type Attachment } from '../model/schema.js';

export type NewAttachment = Pick<Attachment, 'ticketId' | 'fileUrl' | 'fileName' | 'fileType' | 'uploadedBy'>;

export class AttachmentRepository {
  constructor(private readonly db: Database) {}

  async insert(values: NewAttachment, ex: Executor = this.db): Promise<Attachment> {
    const [row] = await ex.insert(attachments).values(values).returning();
    return row!;
  }

  async findById(id: number, ex: Executor = this.db): Promise<Attachment | null> {
    const [row] = await ex.select().from(attachments).where(eq(attachments.attachmentId, id)).limit(1);
    return row ?? null;
  }

  async listByTicket(ticketId: number, ex: Executor = this.db): Promise<Attachment[]> {
    return ex.select().from(attachments).where(eq(attachments.ticketId, ticketId)).orderBy(asc(attachments.attachmentId));
  }

  async countByTicket(ticketId: number, ex: Executor = this.db): Promise<number> {
    const [{ total } = { total: 0 }] = await ex.select({ total: count() }).from(attachments).where(eq(attachments.ticketId, ticketId));
    return total;
  }

  async delete(id: number, ex: Executor = this.db): Promise<void> {
    await ex.delete(attachments).where(eq(attachments.attachmentId, id));
  }
}
