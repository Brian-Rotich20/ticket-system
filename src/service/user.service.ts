import { toPage } from '../dto/common.dto.js';
import type { CreateUserInput, ListUsersQuery, LoginInput, RegisterInput } from '../dto/user.dto.js';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, isUniqueViolation } from '../exception/errors.js';
import type { User } from '../model/schema.js';
import type { UserRepository } from '../repository/user.repository.js';
import type { AuthUser } from '../auth/auth-user.js'
import type { AuditService } from './audit.service.js';
import { assertRole } from './policy.js';
import type { Database } from '../config/db.js';

export interface PublicUser {
  userId: string; tenantId: string; name: string; email: string;
  role: User['role']; emailVerified: boolean; createdAt: Date; updatedAt: Date;
}
export const toPublicUser = (u: User): PublicUser => ({
  userId: u.id, tenantId: u.tenantId, name: u.name, email: u.email,
  role: u.role, emailVerified: u.emailVerified, createdAt: u.createdAt, updatedAt: u.updatedAt,
});
export class UserService {
  constructor(
    private readonly db: Database,
    private readonly users: UserRepository,
    private readonly audit: AuditService,
  ) {}

 

  /** Admin creates users with any role (how agents are onboarded). */
async createUser(actor: AuthUser, input: CreateUserInput): Promise<PublicUser> {
  assertRole(actor, 'ADMIN');
  let createdId: string;
  try {
    const res = await this.auth.api.signUpEmail({
      body: { name: input.name, email: input.email, password: input.password, tenantId: actor.tenantId },
    });
    createdId = res.user.id;
  } catch (err) {
    if (err instanceof APIError) {
      const code = (err.body as { code?: string } | undefined)?.code ?? '';
      if (code.includes('USER_ALREADY_EXISTS')) throw new ConflictError('A user with this email already exists', 'EMAIL_TAKEN');
      throw new ValidationError(err.message || 'Could not create user');
    }
    throw err;
  }
  return this.db.transaction(async (tx) => {
    const user = input.role === 'CUSTOMER'
      ? await this.users.findById(actor.tenantId, createdId, tx)
      : await this.users.setRole(actor.tenantId, createdId, input.role, tx);
    if (!user) throw new NotFoundError('User', createdId);
    await this.audit.record(
      { tenantId: actor.tenantId, actorId: actor.id, action: 'USER_CREATED', entityType: 'USER', entityId: user.id, metadata: { role: user.role } },
      tx,
    );
    return toPublicUser(user);
  });
}


  /** GET /users/{id}: staff can look anyone up; customers only themselves. */
  async getUserById(actor: AuthUser, id: string): Promise<PublicUser> {
    if (actor.role === 'CUSTOMER' && actor.id !== id) throw new ForbiddenError();
    const user = await this.users.findById(actor.tenantId, id);
    if (!user) throw new NotFoundError('User', id);
    return toPublicUser(user);
  }

  /** GET /users (list users for assignment): staff only. */
  async listUsers(actor: AuthUser, q: ListUsersQuery) {
    assertRole(actor, 'AGENT', 'ADMIN');
    const { items, total } = await this.users.list({ role: q.role, limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    return toPage(items.map(toPublicUser), total, q);
  }
}
