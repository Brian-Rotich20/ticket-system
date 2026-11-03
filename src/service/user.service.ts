import { toPage } from '../dto/common.dto.js';
import type { CreateUserInput, ListUsersQuery, LoginInput, RegisterInput } from '../dto/user.dto.js';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, isUniqueViolation } from '../exception/errors.js';
import type { User } from '../model/schema.js';
import type { UserRepository } from '../repository/user.repository.js';
import type { Actor } from './actor.js';
import type { AuditService } from './audit.service.js';
import { hashPassword, verifyPassword } from './password.js';
import { assertRole } from './policy.js';
import type { Database } from '../config/db.js';

export type PublicUser = Omit<User, 'passwordHash'>;
export const toPublicUser = ({ passwordHash: _omit, ...rest }: User): PublicUser => rest;

export class UserService {
  constructor(
    private readonly db: Database,
    private readonly users: UserRepository,
    private readonly audit: AuditService,
  ) {}

  /** Public self sign-up: always creates a CUSTOMER. */
  register(input: RegisterInput): Promise<PublicUser> {
    return this.create(null, { ...input, role: 'CUSTOMER' });
  }

  /** Admin creates users with any role (how agents are onboarded). */
  createUser(actor: Actor, input: CreateUserInput): Promise<PublicUser> {
    assertRole(actor, 'ADMIN');
    return this.create(actor.userId, input);
  }

  private async create(actorId: number | null, input: CreateUserInput): Promise<PublicUser> {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db.transaction(async (tx) => {
        const user = await this.users.insert({ name: input.name, email: input.email, role: input.role, passwordHash }, tx);
        await this.audit.record(
          { actorId: actorId ?? user.userId, action: 'USER_CREATED', entityType: 'USER', entityId: user.userId, metadata: { role: user.role } },
          tx,
        );
        return toPublicUser(user);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('A user with this email already exists', 'EMAIL_TAKEN');
      throw err;
    }
  }

  async authenticate(input: LoginInput): Promise<PublicUser> {
    const user = await this.users.findByEmail(input.email);
    const ok = user ? await verifyPassword(input.password, user.passwordHash) : false;
    if (!user || !ok) throw new UnauthorizedError('Invalid email or password'); // same message: no user enumeration
    return toPublicUser(user);
  }

  /** GET /users/{id}: staff can look anyone up; customers only themselves. */
  async getUserById(actor: Actor, id: number): Promise<PublicUser> {
    if (actor.role === 'CUSTOMER' && actor.userId !== id) throw new ForbiddenError();
    const user = await this.users.findById(id);
    if (!user) throw new NotFoundError('User', id);
    return toPublicUser(user);
  }

  /** GET /users (list users for assignment): staff only. */
  async listUsers(actor: Actor, q: ListUsersQuery) {
    assertRole(actor, 'AGENT', 'ADMIN');
    const { items, total } = await this.users.list({ role: q.role, limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    return toPage(items.map(toPublicUser), total, q);
  }
}
