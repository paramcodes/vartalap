/**
 * The prod shell around the static build (ADR 0062).
 *
 * One origin: serves `dist/` and proxies `/api/*` + `/__csp` to the realtime
 * service, so the `lax` cookie never crosses origins. Mints the CSP nonce per
 * document request and injects it into the served HTML — mint and inject in
 * one process, so the 0040 mismatch (middleware mints, renderer reads, blank
 * page) cannot occur.
 *
 * Node, not Bun: the decisions index pins Node for `apps/web`.
 * CSP ships report-only in 6.0; the flip to enforcing is 0040's one-week rule.
 *
 *     bun run --filter=@vartalap/web build   # vite build → dist/
 *     node ./dist-server/server.js            # serves dist/ on $WEB_PORT
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const dist = join(import.meta.dirname, '..', 'dist');
const realtime = (process.env.REALTIME_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function securityHeaders(nonce: string): Record<string, string> {
  return {
    // Report-only until the reports have been read (ADR 0040).
    'content-security-policy-report-only':
      `default-src 'self'; base-uri 'none'; object-src 'none'; ` +
      `form-action 'self'; frame-ancestors 'none'; ` +
      `script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; ` +
      `img-src 'self' blob: data:; font-src 'self'; ` +
      `connect-src 'self'; worker-src 'self' blob:; report-uri /__csp`,
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

async function proxy(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const body = ['GET', 'HEAD'].includes(request.method ?? 'GET') ? undefined : Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value && key.toLowerCase() !== 'host') {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
  }
  const target = await fetch(`${realtime}${path}`, {
    method: request.method ?? 'GET',
    headers,
    body: body ?? null,
  });
  const resHeaders: Record<string, string | string[]> = {};
  for (const [key, value] of target.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') {
      const getSetCookie = (target.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
      resHeaders[key] = typeof getSetCookie === 'function' ? getSetCookie.call(target.headers) : value;
    } else {
      resHeaders[key] = value;
    }
  }
  response.writeHead(target.status, resHeaders);
  response.end(Buffer.from(await target.arrayBuffer()));
}

async function serveDocument(response: ServerResponse): Promise<void> {
  const nonce = randomUUID().replace(/-/g, '');
  const html = (await readFile(join(dist, 'index.html'), 'utf8')).replace(
    '<script type="module"',
    `<script nonce="${nonce}" type="module"`,
  );
  const headers = securityHeaders(nonce);
  headers['content-type'] = 'text/html; charset=utf-8';
  // The nonce forbids edge-caching the document (ADR 0040). Hashed assets below stay cacheable.
  headers['cache-control'] = 'private, no-store';
  response.writeHead(200, headers);
  response.end(html);
}

async function serveAsset(path: string, response: ServerResponse): Promise<void> {
  const ext = path.slice(path.lastIndexOf('.'));
  try {
    const body = await readFile(join(dist, path));
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    response.end(body);
  } catch {
    await serveDocument(response);
  }
}

export function start(port = Number(process.env.WEB_PORT ?? 4173)) {
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/__csp' || path.startsWith('/api/')) {
      void proxy(request, response, path);
      return;
    }
    if (path === '/') {
      void serveDocument(response);
      return;
    }
    void serveAsset(path, response);
  }).listen(port);
}

if (import.meta.main) {
  const server = start();
  server.on('listening', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : process.env.WEB_PORT ?? 4173;
    console.log(`web       http://localhost:${port}`);
    console.log(`realtime  ${realtime}`);
  });
}
