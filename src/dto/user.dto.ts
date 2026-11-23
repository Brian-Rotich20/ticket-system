import { z } from 'zod';
import { MEMBER_ROLES, MEMBER_STATUSES } from '../model/enums.js';
import { paginationQuery } from './common.dto.js';

export const emailSchema = z.string().trim().toLowerCase().email().max(255);
export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(128);

/** Admin-only: create a staff account directly in the admin's organization (the alternative to an invitation). */
export const createUserDto = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(MEMBER_ROLES),
});
export type CreateUserInput = z.infer<typeof createUserDto>;

/** Admin-only: change a member's role, or deactivate / re-activate them. */
export const updateMemberDto = z
  .object({ role: z.enum(MEMBER_ROLES).optional(), status: z.enum(MEMBER_STATUSES).optional() })
  .refine((v) => v.role !== undefined || v.status !== undefined, { message: 'Provide role and/or status' });
export type UpdateMemberInput = z.infer<typeof updateMemberDto>;

export const listUsersQuery = paginationQuery.extend({
  role: z.enum(MEMBER_ROLES).optional(),
  status: z.enum(MEMBER_STATUSES).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuery>;

export const auditQuery = paginationQuery.extend({
  entityType: z.string().max(30).optional(),
  entityId: z.string().max(64).optional(),
  actorId: z.string().max(64).optional(),
  action: z.string().max(60).optional(),
});
export type AuditQuery = z.infer<typeof auditQuery>;
