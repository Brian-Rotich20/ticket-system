import { z } from 'zod';
import { USER_ROLES } from '../model/enums.js';
import { paginationQuery } from './common.dto.js';

/** Admin-only: create a user (e.g. an agent) inside the admin's own tenant. */
export const createUserDto = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  role: z.enum(USER_ROLES),
});
export type CreateUserInput = z.infer<typeof createUserDto>;

export const listUsersQuery = paginationQuery.extend({ role: z.enum(USER_ROLES).optional() });
export type ListUsersQuery = z.infer<typeof listUsersQuery>;

export const auditQuery = paginationQuery.extend({
  entityType: z.string().max(30).optional(),
  entityId: z.string().max(64).optional(),
});
export type AuditQuery = z.infer<typeof auditQuery>;