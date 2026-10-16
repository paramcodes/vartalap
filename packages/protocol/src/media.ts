import { z } from 'zod';
import { mediaId } from './scalars.ts';

export const presignMediaRequest = z.object({
  filename: z.string().min(1).max(255),
});

export type PresignMediaRequest = z.infer<typeof presignMediaRequest>;

export const presignMediaResponse = z.object({
  mediaId,
  uploadUrl: z.string(),
});

export type PresignMediaResponse = z.infer<typeof presignMediaResponse>;
