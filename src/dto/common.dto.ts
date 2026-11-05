import { z } from 'zod';

/** Numeric id in the URL (tickets, comments, attachments). */
export const idParam = z.object({ id: z.coerce.number().int().positive() });
/** Better Auth user ids are strings. */
export const userIdParam = z.object({ id: z.string().min(1).max(64) });

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function toPage<T>(items: T[], total: number, p: PaginationQuery): Page<T> {
  return { items, page: p.page, pageSize: p.pageSize, total, totalPages: Math.ceil(total / p.pageSize) };
}