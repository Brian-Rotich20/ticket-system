import { z } from 'zod';

export const createCommentDto = z.object({
  text: z.string().trim().min(1, 'Comment cannot be empty').max(5_000),
});
export type CreateCommentInput = z.infer<typeof createCommentDto>;
