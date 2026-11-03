import { z } from 'zod';
import { USER_ROLES } from '../model/enums.js';
import { paginationQuery } from './common.dto.js';

const email = z.string().trim().toLowerCase().email().max(255);
const password = z.string().min(8, 'Password must be at least 8 characters').max(128);
const name = z.string().trim().min(1).max(120);

export const registerDto = z.object({ name, email, password });
export type RegisterInput = z.infer<typeof registerDto>;

export const loginDto = z.object({ email, password: z.string().min(1).max(128) });
export type LoginInput = z.infer<typeof loginDto>;

/** Admin-only: create users with any role (e.g. agents). */
export const createUserDto = registerDto.extend({ role: z.enum(USER_ROLES) });
export type CreateUserInput = z.infer<typeof createUserDto>;

export const listUsersQuery = paginationQuery.extend({ role: z.enum(USER_ROLES).optional() });
export type ListUsersQuery = z.infer<typeof listUsersQuery>;

export const auditQuery = paginationQuery.extend({
  entityType: z.string().max(30).optional(),
  entityId: z.coerce.number().int().positive().optional(),
});
export type AuditQuery = z.infer<typeof auditQuery>;
