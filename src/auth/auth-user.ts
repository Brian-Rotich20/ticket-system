import type { MemberRole } from '../model/enums.js';

/** The signed-in account, resolved from the Better Auth session. Not tied to any organization. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * The caller of an organization-scoped route: the session user plus their ACTIVE membership of the organization
 * named by the X-Organization-Id header. Available as `request.user`. `tenantId` is the organization id.
 */
export interface AuthUser extends SessionUser {
  tenantId: string;
  role: MemberRole;
}
