import { z } from 'zod';
import { MEMBER_ROLES } from '../model/enums.js';
import { emailSchema, passwordSchema } from './user.dto.js';

const organizationName = z.string().trim().min(2, 'Business name must be at least 2 characters').max(120);
const personName = z.string().trim().min(1, 'Name cannot be empty').max(120);

/** POST /api/auth/register: the business owner creates their account and organization. */
export const registerDto = z.object({
  name: personName,
  email: emailSchema,
  password: passwordSchema,
  organizationName,
});
export type RegisterInput = z.infer<typeof registerDto>;

/** Admin-only business profile. `logo` is a public https URL, or null to remove it. */
export const updateOrganizationDto = z
  .object({
    name: organizationName.optional(),
    logo: z.string().trim().url().max(500).startsWith('https://', 'Logo must be an https URL').nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.logo !== undefined, { message: 'Provide name and/or logo' });
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationDto>;

export const createInvitationDto = z.object({
  email: emailSchema,
  role: z.enum(MEMBER_ROLES).default('AGENT'),
});
export type CreateInvitationInput = z.infer<typeof createInvitationDto>;

/** Accepting an invitation without an account creates one (name + password); a signed-in invitee sends nothing. */
export const acceptInvitationDto = z
  .object({ name: personName.optional(), password: passwordSchema.optional() })
  .default({});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationDto>;

export const tokenParam = z.object({ token: z.string().min(1).max(128) });
