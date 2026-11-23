import { z } from 'zod';
import { paginationQuery } from './common.dto.js';

/** Removes spaces, dashes, dots and brackets so "0712 345-678" and "0712345678" are the same contact. */
export const normalizePhone = (raw: string) => raw.replace(/[\s\-.()]/g, '');

export const phoneSchema = z
  .string()
  .trim()
  .transform(normalizePhone)
  .pipe(z.string().regex(/^\+?\d{7,15}$/, 'Enter a phone number of 7 to 15 digits, optionally starting with +'));

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .transform((v) => (v === '' ? null : v))
  .pipe(z.string().email().nullable())
  .nullable()
  .optional();

export const createContactDto = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty').max(120),
  phone: phoneSchema,
  email: optionalEmail,
});
export type CreateContactInput = z.infer<typeof createContactDto>;

export const contactListQuery = paginationQuery.extend({
  q: z.string().trim().max(120).optional(),
});
export type ContactListQuery = z.infer<typeof contactListQuery>;
