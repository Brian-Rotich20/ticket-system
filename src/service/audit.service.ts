import type { AuthUser } from '../auth/auth-user.js';
import type { Executor } from '../config/db.js';
import { toPage } from '../dto/common.dto.js';
import type { AuditQuery } from '../dto/user.dto.js';
import type { AuditEntry, AuditRepository } from '../repository/audit.repository.js';
import { assertRole } from './policy.js';

export class AuditService {
  constructor(private readonly repo: AuditRepository) {}

  /** Pass the transaction handle so the audit row commits/rolls back with the change it describes. */
  record(entry: AuditEntry, ex?: Executor) {
    return this.repo.insert(entry, ex);
  }

  async list(actor: AuthUser, q: AuditQuery) {
    assertRole(actor, 'ADMIN');
    const { items, total } = await this.repo.list(actor.tenantId, q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    return toPage(items, total, q);
  }
}