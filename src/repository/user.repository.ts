import { and, count, eq, inArray } from 'drizzle-orm';
import type { Database, Executor } from '../config/db.js';
import type { UserRole } from '../model/enums.js';
import { users, type NewUser, type User } from '../model/schema.js';

export class UserRepository {
  constructor(private readonly db: Database) {}

  async findById(id: number, ex: Executor = this.db): Promise<User | null> {
    const [row] = await ex.select().from(users).where(eq(users.userId, id)).limit(1);
    return row ?? null;
  }

  async findByEmail(email: string, ex: Executor = this.db): Promise<User | null> {
    const [row] = await ex.select().from(users).where(eq(users.email, email)).limit(1);
    return row ?? null;
  }

  async findManyByIds(ids: number[], ex: Executor = this.db): Promise<User[]> {
    if (ids.length === 0) return [];
    return ex.select().from(users).where(inArray(users.userId, ids));
  }

  async insert(values: NewUser, ex: Executor = this.db): Promise<User> {
    const [row] = await ex.insert(users).values(values).returning();
    return row!;
  }

  async list(opts: { role?: UserRole; limit: number; offset: number }, ex: Executor = this.db) {
    const where = opts.role ? eq(users.role, opts.role) : undefined;
    const items = await ex.select().from(users).where(where).orderBy(users.userId).limit(opts.limit).offset(opts.offset);
    const [{ total } = { total: 0 }] = await ex.select({ total: count() }).from(users).where(where);
    return { items, total };
  }

  async listByRole(role: UserRole, ex: Executor = this.db): Promise<User[]> {
    return ex.select().from(users).where(and(eq(users.role, role)));
  }
}
