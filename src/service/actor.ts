import type { UserRole } from '../model/enums.js';

/** The authenticated caller, derived from the JWT. */
export interface Actor {
  userId: number;
  role: UserRole;
}
