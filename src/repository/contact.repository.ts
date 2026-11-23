import { and, count, desc, eq, ilike, or, type SQL } from 'drizzle-orm';
import type { Database, Executor } from '../config/db.js';
import { contacts, type Contact } from '../model/schema.js';
import { escapeLike } from './sql-helpers.js';

export type NewContact = Pick<Contact, 'tenantId' | 'name' | 'phone' | 'email'>;

/** Every query is scoped by tenantId: another organization's contact does not exist for the caller. */
export class ContactRepository {
  constructor(private readonly db: Database) {}

  async insert(values: NewContact, ex: Executor = this.db): Promise<Contact> {
    const [row] = await ex.insert(contacts).values(values).returning();
    return row!;
  }

  /**
   * Inserts the contact unless its phone number already exists in the organization (race-safe through the
   * unique index; no error aborts the surrounding transaction). Returns null when the phone is taken.
   */
  async insertIfNewPhone(values: NewContact, ex: Executor = this.db): Promise<Contact | null> {
    const [row] = await ex.insert(contacts).values(values).onConflictDoNothing().returning();
    return row ?? null;
  }

  async findById(tenantId: string, id: number, ex: Executor = this.db): Promise<Contact | null> {
    const [row] = await ex
      .select()
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.contactId, id)))
      .limit(1);
    return row ?? null;
  }

  async findByPhone(tenantId: string, phone: string, ex: Executor = this.db): Promise<Contact | null> {
    const [row] = await ex
      .select()
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.phone, phone)))
      .limit(1);
    return row ?? null;
  }

  /** Search by name, phone or e-mail; newest first. */
  async list(tenantId: string, opts: { q?: string; limit: number; offset: number }, ex: Executor = this.db) {
    let search: SQL | undefined;
    if (opts.q) {
      const like = `%${escapeLike(opts.q)}%`;
      search = or(ilike(contacts.name, like), ilike(contacts.phone, like), ilike(contacts.email, like));
    }
    const where = and(eq(contacts.tenantId, tenantId), search);
    const items = await ex
      .select()
      .from(contacts)
      .where(where)
      .orderBy(desc(contacts.createdAt), desc(contacts.contactId))
      .limit(opts.limit)
      .offset(opts.offset);
    const [{ total } = { total: 0 }] = await ex.select({ total: count() }).from(contacts).where(where);
    return { items, total };
  }
}
