/**
 * The realtime service. A `Bun.serve` shell, a router, and the auth boundary.
 *
 * **No HTTP framework, on purpose.** This will be six routes. Hono would add a
 * dependency, a second place where routing is defined, and a layer between a
 * request and the code that has to be trusted — to save a `switch`. The spine
 * (send, history, catch-up, receipts) is the part stage 3 exists to prove, and
 * it should be reachable by reading this file top to bottom.
 *
 * What this file is NOT allowed to become: a place where the spine lives. Nothing
 * here writes a message, publishes a frame, or knows what a `seq` is. Each route
 * lives in `src/spine/*` and is reached through one line below.
 *
 *     bun run realtime          # from the repo root
 */
import { auth } from '@vartalap/auth';
import { fail, json, notFound, unauthenticated } from './http.ts';
import { requireSession } from './session.ts';
import { handleBlocks } from './spine/blocks-route.ts';
import { handleCatchUp } from './spine/catch-up-route.ts';
import { handleLeaveRejoin } from './spine/leave-route.ts';
import { handleListConversations } from './spine/list-route.ts';
import { handleMembership } from './spine/membership-route.ts';
import { handleCreateConversation } from './spine/conversations-route.ts';
import { handleDeliveryAck } from './spine/delivery-route.ts';
import { handleHistory } from './spine/history-route.ts';
import { handleReceiptAdvance, handleReceiptSharing } from './spine/receipt-route.ts';
import { handlePush } from './spine/push-route.ts';
import { handleSearch } from './spine/search-route.ts';
import { handleSendMessage } from './spine/send-route.ts';

/**
 * Better Auth's own default base path, restated so the mount point and the
 * library cannot drift apart silently: if either changes, this comparison stops
 * matching and every auth route 404s.
 */
const AUTH_PREFIX = '/api/auth';

export async function handleRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === '/health' && request.method === 'GET') {
    return json({ ok: true });
  }

  // Better Auth owns this whole prefix. Mounted rather than reimplemented:
  // `auth.handler` IS the HTTP surface for sign-up, sign-in, session and sign-out,
  // and before this file existed nothing in the repo routed a request to it —
  // `@vartalap/auth` was exported and unreachable over HTTP.
  if (pathname === AUTH_PREFIX || pathname.startsWith(`${AUTH_PREFIX}/`)) {
    return auth.handler(request);
  }

  // The protected route that proves the session boundary works. It is a
  // harness, not a product route: it exists so 3.A can show an anonymous caller
  // gets 401 and a signed-in caller gets their own id back.
  if (pathname === '/api/me') {
    if (request.method !== 'GET') {
      return fail({ code: 'methodNotAllowed', message: 'use GET here', retryable: false }, 405);
    }
    const userId = await requireSession(request);
    if (userId === null) return unauthenticated();
    const result = await auth.api.getSession({ headers: request.headers });
    const user = result?.user;
    return json({
      userId,
      handle: user?.username ?? null,
      displayName: user?.name ?? null,
    });
  }

  // ── the spine. One line per route; each answers `null` for a path it does not own.
  const history = await handleHistory(request, pathname);
  if (history !== null) return history;

  const catchUp = await handleCatchUp(request, pathname);
  if (catchUp !== null) return catchUp;

  const sent = await handleSendMessage(request, pathname);
  if (sent !== null) return sent;

  const advanced = await handleReceiptAdvance(request, pathname);
  if (advanced !== null) return advanced;

  const shared = await handleReceiptSharing(request, pathname);
  if (shared !== null) return shared;

  const acknowledged = await handleDeliveryAck(request, pathname);
  if (acknowledged !== null) return acknowledged;

  const created = await handleCreateConversation(request, pathname);
  if (created !== null) return created;

  const blocks = await handleBlocks(request, pathname);
  if (blocks !== null) return blocks;

  const membership = await handleLeaveRejoin(request, pathname);
  if (membership !== null) return membership;

  const list = await handleListConversations(request, pathname);
  if (list !== null) return list;

  const search = await handleSearch(request, pathname);
  if (search !== null) return search;

  const push = await handlePush(request, pathname);
  if (push !== null) return push;

  // Single-segment conversation reads sort last: every deeper path
  // (`/history`, `/messages`) owns its own regex above.
  const oneConversation = await handleMembership(request, pathname);
  if (oneConversation !== null) return oneConversation;

  return notFound(pathname);
}

export function start(port = Number(process.env.REALTIME_PORT ?? 3000)) {
  return Bun.serve({ port, hostname: '127.0.0.1', fetch: handleRequest });
}

if (import.meta.main) {
  const server = start();
  // `BETTER_AUTH_URL` must be this origin. Same-origin is the documented
  // assumption in `packages/auth/src/auth.ts` — if the web app and this service
  // are ever split, `sameSite: 'none'` + `secure` is required and the default in
  // that file will break quietly.
  console.log(`realtime  http://${server.hostname}:${server.port}`);
  console.log(`auth      ${process.env.BETTER_AUTH_URL ?? '(unset)'}${AUTH_PREFIX}`);
  console.log(`database  ${process.env.DATABASE_URL ?? '(unset)'}`);
}
