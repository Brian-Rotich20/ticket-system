import type { AuthUser } from '../auth/auth-user.js';
import type { Database, Executor } from '../config/db.js';
import { toPage, type PaginationQuery } from '../dto/common.dto.js';
import type { ContactListQuery, CreateContactInput } from '../dto/contact.dto.js';
import { ConflictError, NotFoundError } from '../exception/errors.js';
import type { Contact } from '../model/schema.js';
import type { ContactRepository } from '../repository/contact.repository.js';
import type { TicketRepository } from '../repository/ticket.repository.js';
import type { AuditService } from './audit.service.js';

/** Customer contacts of an organization. Contacts have no accounts; staff record them. */
export class ContactService {
  constructor(
    private readonly db: Database,
    private readonly contacts: ContactRepository,
    private readonly tickets: TicketRepository,
    private readonly audit: AuditService,
  ) {}

  /** POST /contacts. A phone number that already exists in the organization is a 409 naming the existing contact. */
  async createContact(actor: AuthUser, input: CreateContactInput): Promise<Contact> {
    return this.db.transaction(async (tx) => {
      const contact = await this.contacts.insertIfNewPhone(this.values(actor, input), tx);
      if (!contact) throw this.duplicate(await this.contacts.findByPhone(actor.tenantId, input.phone, tx));
      await this.recordCreated(actor, contact, tx);
      return contact;
    });
  }

  /**
   * For ticket creation: the existing contact `contactId`, or the contact described by `input`, reusing the
   * organization's contact with the same phone number instead of creating a duplicate. Runs in the caller's transaction.
   */
  async resolveForTicket(actor: AuthUser, ref: { contactId?: number; contact?: CreateContactInput }, tx: Executor): Promise<Contact> {
    if (ref.contactId !== undefined) {
      const found = await this.contacts.findById(actor.tenantId, ref.contactId, tx);
      if (!found) throw new NotFoundError('Contact', ref.contactId);
      return found;
    }
    const input = ref.contact!;
    const created = await this.contacts.insertIfNewPhone(this.values(actor, input), tx);
    if (created) {
      await this.recordCreated(actor, created, tx);
      return created;
    }
    const existing = await this.contacts.findByPhone(actor.tenantId, input.phone, tx);
    if (!existing) throw new ConflictError('Could not create the contact, retry');
    return existing;
  }

  listContacts(actor: AuthUser, q: ContactListQuery) {
    return this.contacts
      .list(actor.tenantId, { q: q.q || undefined, limit: q.pageSize, offset: (q.page - 1) * q.pageSize })
      .then(({ items, total }) => toPage(items, total, q));
  }

  async getContact(actor: AuthUser, contactId: number): Promise<Contact> {
    const contact = await this.contacts.findById(actor.tenantId, contactId);
    if (!contact) throw new NotFoundError('Contact', contactId);
    return contact;
  }

  /** GET /contacts/:id/tickets: the contact's ticket history, newest first. */
  async getContactTickets(actor: AuthUser, contactId: number, p: PaginationQuery) {
    await this.getContact(actor, contactId); // 404 for another organization's contact
    const { items, total } = await this.tickets.list(
      actor.tenantId,
      { contactId },
      { limit: p.pageSize, offset: (p.page - 1) * p.pageSize, sortBy: 'createdAt', order: 'desc' },
    );
    return toPage(items, total, p);
  }

  private values(actor: AuthUser, input: CreateContactInput) {
    return { tenantId: actor.tenantId, name: input.name, phone: input.phone, email: input.email ?? null };
  }

  private recordCreated(actor: AuthUser, contact: Contact, tx: Executor) {
    return this.audit.record(
      { tenantId: actor.tenantId, actorId: actor.id, action: 'CONTACT_CREATED', entityType: 'CONTACT', entityId: contact.contactId, metadata: { name: contact.name } },
      tx,
    );
  }

  private duplicate(existing: Contact | null) {
    return new ConflictError(
      'A contact with this phone number already exists',
      'CONTACT_EXISTS',
      existing ? { contactId: existing.contactId, name: existing.name } : undefined,
    );
  }
}
