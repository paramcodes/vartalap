/**
 * Static server for `prototype/`, so the prototypes can be opened over http rather
 * than `file://`.
 *
 * Not cosmetic. Two of the prototypes behave differently on `file://`:
 *
 *   - `localStorage` throws a SecurityError for `file://` origins in Chromium, and
 *     `prototype/messenger-shell/desktop.html` stores pane state there. On `file://`
 *     its own try/catch swallows it and the persistence silently stops working.
 *   - Tailwind's browser build resolves relative URLs against the document, which
 *     `file://` makes fragile once a prototype pulls in a second file.
 *
 * Read-only by construction. It serves bytes from one directory and refuses to
 * resolve outside it, so it cannot be pointed at the repo by accident.
 *
 * Bun built-ins only. Run from the repo root: `bun run proto`.
 */
import { join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', 'prototype');
const PORT = Number(process.env.PROTO_PORT ?? 4173);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = Bun.serve({
  port: PORT,
  hostname: 'localhost',

  async fetch(req) {
    const { pathname } = new URL(req.url);

    // A directory request means "the index page", which is what a person typing a
    // folder path expects and what a static file server would not do.
    const requested = pathname.endsWith('/') ? `${pathname}index.html` : pathname;

    // normalize collapses `..`; the prefix check is what actually stops escape.
    const target = normalize(join(ROOT, decodeURIComponent(requested)));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      return new Response('forbidden', { status: 403 });
    }

    const file = Bun.file(target);
    if (!(await file.exists())) {
      return new Response('not found', { status: 404 });
    }

    return new Response(file, {
      headers: {
        'content-type': MIME[target.slice(target.lastIndexOf('.'))] ?? 'application/octet-stream',
        // Prototypes are edited and reloaded constantly; a cached copy is always wrong.
        'cache-control': 'no-store',
      },
    });
  },
});

console.log(`prototypes on http://localhost:${server.port}/`);
console.log(`serving ${ROOT}`);
