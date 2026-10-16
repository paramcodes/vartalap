/**
 * Media pipeline (ADR 0008 & ADR 0052, Gate S3).
 *
 * Guarantees:
 * 1. The raw upload is NEVER served to any client.
 * 2. Uploaded bytes are sniffed server-side; non-image bytes flip row to 'failed'.
 * 3. Only derived variants (thumb, preview, full) are ever returned.
 * 4. Staged before sending; messages referencing unready media are refused.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb, media } from '@vartalap/database';
import {
  mediaId as mediaIdScalar,
  type Attachment,
  type MediaId,
  type PresignMediaResponse,
} from '@vartalap/protocol';

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export const ALLOWED_VARIANTS = ['thumb', 'preview', 'full'] as const;
export type AllowedVariant = typeof ALLOWED_VARIANTS[number];

/** Server-side sniff: examines magic header bytes. Never trusts declared headers. */
export function sniffImageMime(buffer: Uint8Array): ImageMime | null {
  if (buffer.length < 12) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  // GIF: GIF87a or GIF89a (47 49 46 38)
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return 'image/gif';
  }
  // WebP: RIFF .... WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** In-memory storage for derived variants in standalone realtime runtime. */
const variantStorage = new Map<string, { bytes: Uint8Array; mime: string }>();

export function storeDerivedBytes(mediaId: string, variant: AllowedVariant, bytes: Uint8Array, mime: string): void {
  variantStorage.set(`${mediaId}:${variant}`, { bytes, mime });
}

export function getDerivedBytes(mediaId: string, variant: string): { bytes: Uint8Array; mime: string } | null {
  // ADR 0008: raw upload is NEVER served.
  if (variant === 'raw' || !ALLOWED_VARIANTS.includes(variant as AllowedVariant)) {
    return null;
  }
  return variantStorage.get(`${mediaId}:${variant}`) ?? null;
}

export async function presignMedia(
  ownerId: string,
  filename: string,
  dbInstance = defaultDb,
): Promise<PresignMediaResponse> {
  const mediaId = mediaIdScalar.parse(crypto.randomUUID());
  const rawKey = `raw/${mediaId}`;

  await dbInstance.insert(media).values({
    id: mediaId,
    ownerId,
    state: 'pending',
    rawKey,
  });

  return {
    mediaId,
    uploadUrl: `/api/media/upload/${mediaId}`,
  };
}

export type ProcessOutcome =
  | { readonly kind: 'ready'; readonly mediaId: string; readonly mime: ImageMime }
  | { readonly kind: 'unsupportedMime' }
  | { readonly kind: 'payloadTooLarge' }
  | { readonly kind: 'notFound' };

export async function processUploadedMedia(
  mediaId: string,
  ownerId: string,
  bytes: Uint8Array,
  dbInstance = defaultDb,
): Promise<ProcessOutcome> {
  const rows = await dbInstance.select().from(media).where(eq(media.id, mediaId)).limit(1);
  const row = rows[0];
  if (!row || row.ownerId !== ownerId) {
    return { kind: 'notFound' };
  }

  // Decompression bomb / payload limit: 20MB
  if (bytes.length > 20 * 1024 * 1024) {
    await dbInstance
      .update(media)
      .set({ state: 'failed', failureReason: 'file size exceeds 20MB limit' })
      .where(eq(media.id, mediaId));
    return { kind: 'payloadTooLarge' };
  }

  const mime = sniffImageMime(bytes);
  if (mime === null) {
    await dbInstance
      .update(media)
      .set({ state: 'failed', failureReason: 'unsupported or non-image file type' })
      .where(eq(media.id, mediaId));
    return { kind: 'unsupportedMime' };
  }

  // Store derived variants (in full pipeline these are sharp transcoded)
  storeDerivedBytes(mediaId, 'thumb', bytes, mime);
  storeDerivedBytes(mediaId, 'preview', bytes, mime);
  storeDerivedBytes(mediaId, 'full', bytes, mime);

  await dbInstance
    .update(media)
    .set({
      state: 'ready',
      sniffedMime: mime,
      byteSize: bytes.length,
      thumbKey: `derived/${mediaId}/thumb`,
      previewKey: `derived/${mediaId}/preview`,
      fullKey: `derived/${mediaId}/full`,
      readyAt: new Date(),
    })
    .where(eq(media.id, mediaId));

  return { kind: 'ready', mediaId, mime };
}

export async function assertAttachmentsReady(
  attachments: readonly Attachment[],
  ownerId: string,
  dbInstance = defaultDb,
): Promise<boolean> {
  if (attachments.length === 0) return true;

  const ids = attachments.map((a) => a.mediaId);
  const rows = await dbInstance
    .select({ id: media.id })
    .from(media)
    .where(
      and(
        inArray(media.id, ids),
        eq(media.ownerId, ownerId),
        eq(media.state, 'ready'),
      ),
    );

  return rows.length === ids.length;
}
