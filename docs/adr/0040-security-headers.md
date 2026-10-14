# 0040. The application emits its own security headers, and the CSP is the only one that matters

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "The hardening plan: what production-ready means for a learning project"
**Extends:** [0008](0008-media-pipeline.md), which decided what may ever be served as media
**Feeds:** [`docs/concepts/hardening-backlog.md`](../concepts/hardening-backlog.md)

## Context

The ticket asked a cheap question — *"are the security headers in v1, or explicitly deferred?"* — and
framed it as a binary. It is not a binary, because **the tier that matters was mis-ranked**. The
tier that matters is a Content Security Policy, and the CDN cannot supply one.

The obvious move is to turn on Cloudflare's canned security-header rules, because the origin is
already behind Cloudflare and the whole class of headers is *there*, pre-filled, one click away.
That is what makes it a real decision rather than a checkbox.

## Decision

### The CDN adds no headers. The application emits every one it wants.

### A nonce-based, `strict-dynamic` CSP is on the app origin, shipped report-only first and enforced a week later

### The media origin gets **no** CSP, because a CSP on a non-document response does nothing

### Every deprecated header in the canned set is declined by name

## Why "put it at the CDN" is wrong, precisely

Cloudflare's managed transforms include a security-header set that adds `X-XSS-Protection` and
`Expect-CT`. Both are on OWASP's deprecated-and-removed list:

- **`X-XSS-Protection`** was the switch for the browser-side XSS Auditor, which every major browser
  has since removed. It was not merely useless — the auditor it enabled was itself a known bypass
  class, and the header was how it got switched on.
- **`Expect-CT`** exists to enforce a Certificate Transparency policy the ecosystem has moved off.
  It is deprecated and its browser support is gone.

And that set ships **no CSP at all.** So turning it on produces the exact failure mode the hardening
ticket exists to prevent: a security scanner goes green, a dashboard shows "security headers
configured," and the one header that would actually constrain script injection is still missing.

The deeper reason the CDN cannot own this: **a per-request nonce has to be minted by the process
that renders the response.** A transform rule that rewrites a `static-src` list cannot compute a
nonce that matches the `<script>` tags already in the HTML — by the time the rule runs, the markup
is frozen. Cloudflare can cache HTML and still emit a nonce-shaped string; it cannot emit one that
works. A static `'unsafe-inline'` CSP *is* expressible as a header rule, and that is precisely the
form that does not constrain anything.

## The CSP, and the three decisions inside it

```
default-src    'self'
base-uri       'none'
object-src     'none'
form-action    'self'
frame-ancestors 'none'
script-src     'nonce-{per-request}' 'strict-dynamic'
style-src      'self' 'unsafe-inline'
img-src        'self' blob: data: https://media.{apex}
font-src       'self'
connect-src    'self' wss://realtime.{apex}
worker-src     'self' blob:
report-uri     /__csp
```

**Nonce, not a host allowlist.** `'self'` in `script-src` does nothing to stop an attacker who has
injected a script into the app origin — that script *is* same-origin. The allowlist model protects
the wrong direction for this threat. A nonce attributes a script to a specific render.

**`strict-dynamic`, and no `'unsafe-inline'` fallback tail.** The widely copied pattern adds
`'unsafe-inline' https: 'unsafe-inline'` as a trailing fallback so CSP2-only browsers keep working.
With `'strict-dynamic'` present, any CSP3 browser *ignores* `'unsafe-inline'` and host allowlists in
`script-src` entirely, so the tail is not a hole — it is compatibility scaffolding. It is also the
line a well-meaning reviewer deletes on sight, and deleting it breaks the app on old browsers rather
than making it safer. v1 drops the tail: every browser we support is CSP3, and if one turns out not
to be, the report-only phase is exactly where that would have been caught.

**`style-src 'self' 'unsafe-inline'` is a real grant, named as one.** Virtualised transcripts set
`transform` and `height` through style attributes. The tighter CSP3-only form is
`style-src 'self'; style-src-attr 'unsafe-inline'`, which splits the attribute grant away from
stylesheet loading — but a CSP2 browser falls back to `style-src` and blocks the attribute anyway.
The honest version of this: vartalap needs `unsafe-inline` for attributes, the exposure from it is
CSS-based exfiltration of DOM text, and the marginal risk over the split form is small enough to
accept rather than to break layout code for. It is written down so the next person sees a decision,
not an oversight.

**`connect-src` names the realtime origin explicitly.** `wss://realtime.{apex}` is the one
cross-origin connection the app makes. Everything else — REST, the CSP report endpoint, the service
worker — is `'self'`.

**Web Push needs nothing here.** The Push subscription is negotiated with the browser vendor's push
service from inside the browser, not fetched by the page, so it is not a `connect-src` fetch and
`Permissions-Policy` does not gate it.

## The media origin gets different headers, not a CSP

The instinct is to copy the app's header block onto `media.{apex}`. Do not. Every directive in the
list above governs how a **document** may load subresources, and a JPEG response is not a document.
A CSP served alongside an image is inert.

What the media origin needs is three things, none of which is a CSP:

- `Cross-Origin-Resource-Policy: same-site` — lets the app origin read the variants, denies
  everything else. This is the only one that does real work.
- `X-Content-Type-Options: nosniff` — reinforcement, exactly as [0008](0008-media-pipeline.md) says.
- `Content-Type` from the sniffed allowlist, with the variant bytes already re-encoded by the worker.

This is [0008](0008-media-pipeline.md)'s lesson applied to headers: **the belt is that the raw
upload has no URL.** A header set on the media origin is a courtesy.

## What is declined, and why declining it is the interesting part

**`X-Frame-Options` is still sent, alongside `frame-ancestors 'none'`.** This is not cargo-culting a
legacy header. When both are present CSP wins in browsers that support it; XFO is the only
instruction older browsers read. OWASP still recommends sending both, and it costs 68 bytes.

**`Cross-Origin-Embedder-Policy` is declined.** It buys `SharedArrayBuffer`, which nothing in vartalap
uses, and it costs a cross-origin check on every asset on every page load. `Cross-Origin-Opener-Policy:
same-origin` **is** sent — free, no asset cost, and it severs `window.opener`. Revisited only if a
WASM build with shared memory ever appears.

**`Referrer-Policy: no-referrer`, not `strict-origin-when-cross-origin`.** The stricter default is
wrong here for one reason: vartalap's URL space carries conversation identifiers and handles, and
there is no analytics that need the referrer preserved. There is nothing to buy and something to
lose.

**`Permissions-Policy` denies camera, microphone, geolocation, payment, USB, MIDI and display
capture.** Calls are Tier 3, so nothing in v1 needs any of them.

**`HSTS` ships `max-age=63072000; includeSubDomains` and NOT `preload`.** `preload` is a one-way
door: once a domain is on the preload list, every hostname under it must be HTTPS-only forever. v1
will have a `media.` apex, a `realtime.` apex, and whatever a docs host turns out to be. **Adding
`preload` before that list is final is a way to break the whole registrable domain for everyone.**

## Consequences

- **The nonce forbids CDN caching of the app's HTML.** This is the actual price of the decision and
  it should not be discovered later. Assets stay cached at the edge — they are content-hashed — but
  document responses become per-request. `Cache-Control: private` on HTML is the honest expression
  of it. Anyone who reaches for a CSP *because* they wanted the CDN to cache the shell has picked the
  wrong lever; the shell is a fraction of the bytes.
- **Ship `Content-Security-Policy-Report-Only` first, for one week, then flip to enforcing.** One
  header name, one changed string. The report-only phase is the cheapest CSP rollout that exists:
  it turns "we think the policy is right" into a list of the directives that actually fire, measured.
  The same week is where a missing nonce, a third-party script, and an inline event handler all
  become visible as data instead of as an outage.
- **Reporting endpoint is a Cloudflare Worker at `/__csp`**, not a Next.js route — it must not be
  able to fail a document render, and it must not be able to see a session cookie. `report-uri` is
  used rather than the `Reporting` API's `report-to` because `report-to` requires declaring a
  reporting group in a second header and a JSON body to parse; `report-uri` is one header and a
  POST. Upgrading is a two-line change when the volume justifies it.
- **Any future third-party script has to be nonce-injected**, and that is the friction this buys on
  purpose. It is also why the CDN-hosted-script escape hatch (`'https://cdn.example'`) is
  deliberately absent: adding it would undo the decision invisibly.
- **A nonce has to survive the framework.** In a Next.js app the middleware mints it, the
  document renderer reads it, and a mismatch between the two produces a blank page with a CSP error
  and no stack trace. The framework is not yet pinned by this map; **the header module must not
  depend on one**, and whichever framework lands must be able to read a request-scoped nonce. That
  dependency is the single most likely thing to break the implementation, so it is stated.

## What breaks without this

The app origin serves script with no restriction on where it may have come from. Any XSS — a
third-party dependency, a future unescaped render, a stored-content injection — runs with the
session cookie in reach and the same origin as the API. Nothing else in the backlog catches that,
and it is the one failure mode that escalates from "a bug" to "the whole account".

## What would reverse this

**A static allowlist plus `'unsafe-inline'`, emitted by the app.** It is materially easier, it
caches, and it still blocks the *remote* script-injection case. It stops nothing once an attacker
has script execution. If vartalap ever becomes a small static marketing site plus a login page, this
is the right answer — and at that point the nonce is pure cost.

**Serving the app from a Worker rather than from the framework.** That puts header emission one hop
earlier and makes the nonce a normal `crypto.randomUUID()` in the Worker. It costs a round trip the
framework was going to make anyway. Worth revisiting once the hosting target is chosen, because it
converts the hardest part of this ADR into the easiest.