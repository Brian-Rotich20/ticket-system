import { z } from 'zod';
import { COMMENT_VISIBILITIES } from '../model/enums.js';

const text = z.string().trim().min(1, 'Comment cannot be empty').max(5_000);

/** Staff comment. Visibility is required so an internal note is never published by accident. */
export const createCommentDto = z.object({
  text,
  visibility: z.enum(COMMENT_VISIBILITIES),
});
export type CreateCommentInput = z.infer<typeof createCommentDto>;

/** Customer reply through the tracking link: always PUBLIC. */
export const publicCommentDto = z.object({ text });
export type PublicCommentInput = z.infer<typeof publicCommentDto>;
