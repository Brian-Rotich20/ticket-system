import type { UserRole } from '../model/enums.js';

/** The authenticated caller, resolved from the Better Auth session. Available as `request.user`. */
export interface AuthUser {
  id: string;
  email: string;
  tenantId: string;
  role: UserRole;
}
