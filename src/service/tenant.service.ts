import { NotFoundError } from '../exception/errors.js';
import type { TenantRepository } from '../repository/tenant.repository.js';

export class TenantService {
  constructor(private readonly tenants: TenantRepository) {}

  /** Public info for the sign-up page: the store name only, nothing else. */
  async getPublicInfo(slug: string): Promise<{ id: string; name: string }> {
    const tenant = await this.tenants.findById(slug);
    if (!tenant) throw new NotFoundError('Store');
    return { id: tenant.id, name: tenant.name };
  }
}