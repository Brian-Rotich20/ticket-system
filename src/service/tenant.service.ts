import { randomBytes } from 'node:crypto';
import type { AuthUser } from '../auth/auth-user.js';
import type { Database, Executor } from '../config/db.js';
import type { RegisterInput, UpdateOrganizationInput } from '../dto/organization.dto.js';
import { NotFoundError } from '../exception/errors.js';
import type { Tenant } from '../model/schema.js';
import type { MemberRepository } from '../repository/member.repository.js';
import type { TenantRepository } from '../repository/tenant.repository.js';
import type { AuditService } from './audit.service.js';
import { assertRole } from './policy.js';
import type { UserService } from './user.service.js';

/** "Mama Mboga's Shop!" -> "mama-mbogas-shop" */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'business';
}

export interface OrganizationView {
  id: string;
  name: string;
  logo: string | null;
  createdAt: Date;
}
const toView = (t: Tenant): OrganizationView => ({ id: t.id, name: t.name, logo: t.logo, createdAt: t.createdAt });

/** Organizations (stored as tenants). */
export class TenantService {
  constructor(
    private readonly db: Database,
    private readonly tenants: TenantRepository,
    private readonly members: MemberRepository,
    private readonly users: UserService,
    private readonly audit: AuditService,
  ) {}

  /**
   * POST /api/auth/register: the business owner's account, their organization, and their ADMIN membership.
   * The account is created by Better Auth first; if the organization can't be saved the account is removed again,
   * so a registration either fully succeeds or leaves nothing behind.
   */
  async register(input: RegisterInput) {
    const { userId, headers } = await this.users.createAccount(input);
    try {
      const organization = await this.db.transaction(async (tx) => {
        const tenant = await this.insertWithFreeSlug(input.organizationName, tx);
        await this.members.upsert({ tenantId: tenant.id, userId, role: 'ADMIN' }, tx);
        await this.audit.record(
          { tenantId: tenant.id, actorId: userId, action: 'ORGANIZATION_CREATED', entityType: 'ORGANIZATION', entityId: tenant.id, metadata: { name: tenant.name } },
          tx,
        );
        return tenant;
      });
      return { headers, body: { user: { id: userId, name: input.name, email: input.email }, organization: { ...toView(organization), role: 'ADMIN' as const } } };
    } catch (err) {
      await this.users.deleteAccount(userId).catch(() => undefined);
      throw err;
    }
  }

  /** The organizations the signed-in user is an active member of, with their role in each. */
  listMine(userId: string) {
    return this.members.listOrganizationsForUser(userId);
  }

  async getCurrent(actor: AuthUser) {
    const tenant = await this.tenants.findById(actor.tenantId);
    if (!tenant) throw new NotFoundError('Organization');
    return { ...toView(tenant), role: actor.role };
  }

  /** Admin-only business profile (name, logo). */
  async updateCurrent(actor: AuthUser, input: UpdateOrganizationInput) {
    assertRole(actor, 'ADMIN');
    const tenant = await this.db.transaction(async (tx) => {
      const before = await this.tenants.findById(actor.tenantId, tx);
      if (!before) throw new NotFoundError('Organization');
      const updated = await this.tenants.update(actor.tenantId, { name: input.name, logo: input.logo }, tx);
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorId: actor.id,
          action: 'ORGANIZATION_UPDATED',
          entityType: 'ORGANIZATION',
          entityId: actor.tenantId,
          metadata: { from: { name: before.name, logo: before.logo }, to: { name: updated!.name, logo: updated!.logo } },
        },
        tx,
      );
      return updated!;
    });
    return { ...toView(tenant), role: actor.role };
  }

  /** Public: the business name and logo, nothing else. */
  async getPublicInfo(slug: string): Promise<{ id: string; name: string; logo: string | null }> {
    const tenant = await this.tenants.findById(slug);
    if (!tenant) throw new NotFoundError('Store');
    return { id: tenant.id, name: tenant.name, logo: tenant.logo };
  }

  /** "acme-store", then "acme-store-2" ... and finally a random suffix. */
  private async insertWithFreeSlug(name: string, tx: Executor): Promise<Tenant> {
    const base = slugify(name);
    for (let i = 1; i <= 20; i++) {
      const created = await this.tenants.insertIfFree({ id: i === 1 ? base : `${base}-${i}`, name }, tx);
      if (created) return created;
    }
    const created = await this.tenants.insertIfFree({ id: `${base}-${randomBytes(3).toString('hex')}`, name }, tx);
    if (!created) throw new Error('Could not allocate an organization id');
    return created;
  }
}
