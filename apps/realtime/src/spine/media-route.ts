/**
 * Media routes (ADR 0008, Gate S3).
 *
 * `POST /api/media/presign`
 * `PUT /api/media/upload/{id}`
 * `GET /api/media/{id}/{variant}`
 */
import { presignMediaRequest } from '@vartalap/protocol';
import { fail, invalidRequest, json, methodNotAllowed, notFound, unauthenticated } from '../http.ts';
import { requireSession } from '../session.ts';
import { getDerivedBytes, presignMedia, processUploadedMedia } from './media.ts';

const PRESIGN_ROUTE = '/api/media/presign';
const UPLOAD_ROUTE = /^\/api\/media\/upload\/([^/]+)$/;
const SERVE_ROUTE = /^\/api\/media\/([^/]+)\/([^/]+)$/;

export async function handleMedia(request: Request, pathname: string): Promise<Response | null> {
  // 1. Presign
  if (pathname === PRESIGN_ROUTE) {
    if (request.method !== 'POST') return methodNotAllowed(request.method);
    const userId = await requireSession(request);
    if (userId === null) return unauthenticated();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail({ code: 'invalidRequest', message: 'malformed JSON body', retryable: false }, 400);
    }

    const parsed = presignMediaRequest.safeParse(body);
    if (!parsed.success) {
      return invalidRequest(
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
        'filename is required',
      );
    }

    const presigned = await presignMedia(userId, parsed.data.filename);
    return json(presigned, 201);
  }

  // 2. Upload & Sniff
  const uploadMatch = UPLOAD_ROUTE.exec(pathname);
  if (uploadMatch !== null) {
    if (request.method !== 'PUT') return methodNotAllowed(request.method);
    const userId = await requireSession(request);
    if (userId === null) return unauthenticated();

    const mediaId = uploadMatch[1]!;
    const bytes = new Uint8Array(await request.arrayBuffer());

    const result = await processUploadedMedia(mediaId, userId, bytes);
    if (result.kind === 'notFound') return notFound(pathname);
    if (result.kind === 'payloadTooLarge') {
      return fail({ code: 'payloadTooLarge', message: 'file exceeds 20MB limit', retryable: false }, 413);
    }
    if (result.kind === 'unsupportedMime') {
      return fail({ code: 'unprocessable', message: 'unsupported or non-image format', retryable: false }, 415);
    }

    return json({ ok: true, mediaId: result.mediaId, mime: result.mime });
  }

  // 3. Serve Derived Variants (Raw upload is NEVER served per ADR 0008)
  const serveMatch = SERVE_ROUTE.exec(pathname);
  if (serveMatch !== null) {
    if (request.method !== 'GET') return methodNotAllowed(request.method);
    const mediaId = serveMatch[1]!;
    const variant = serveMatch[2]!;

    if (variant === 'raw') {
      return fail({ code: 'notFound', message: 'raw uploads are never served', retryable: false }, 404);
    }

    const derived = getDerivedBytes(mediaId, variant);
    if (derived === null) return notFound(pathname);

    return new Response(derived.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'content-type': derived.mime,
        'x-content-type-options': 'nosniff',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }

  return null;
}
