import { eq, sql } from 'drizzle-orm';
import type { Database, Executor } from '../config/db.js';
import { users, type User } from '../model/schema.js';

/**
 * Accounts (Better Auth users) are global: one account can be a member of several organizations.
 * Anything organization-specific (role, status, listing a team) goes through MemberRepository.
 */
export class UserRepository {
  constructor(private readonly db: Database) {}

  async findByEmail(email: string, ex: Executor = this.db): Promise<User | null> {
    const [row] = await ex.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`).limit(1);
    return row ?? null;
  }

  /** Removes an account (sessions and credentials cascade). Only used to undo a half-finished registration. */
  async deleteById(id: string, ex: Executor = this.db): Promise<void> {
    await ex.delete(users).where(eq(users.id, id));
  }
}
