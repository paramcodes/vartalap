# 0008. Never serve the raw upload — sniff, allowlist, and serve only derived variants

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Media pipeline and the upload trust boundary"
**Feaches:** message attachments, profile pictures, and the hardening plan
**Teaches:** [`docs/concepts/media-pipeline.md`](../concepts/media-pipeline.md)

## Context

Media is the one part of the system where a stranger's bytes become something a browser executes.
Everything else — text, presence, receipts — is data the server controls. An image upload is a file
the user chose, named, and typed.

Storage was settled: **Cloudflare R2 with direct presigned uploads**, chosen for egress rather than
storage price. A busy conversation replays hundreds of thumbnail URLs per user per session, and R2's
egress is free. That is the right reason and it is the reason to record.

What was not settled is where media trust begins.

## Decision

### The raw upload is never served to anyone

The worker accepts the bytes, sniffs them, and **accepts only an allowlist of image types**. Only
worker-derived variants — `thumb`, `preview`, `full` — are ever served, from a dedicated origin.

### Server-side sniffing is the only content validation, and it is an allowlist

Not the client's declared type, not the type bound into the signature, not the copy in the database.
The bytes are read and the type is derived from them.

### `sharp`, in a separate worker process

Three variants as **fixed columns** on the media row, not a variants document and not resize-on-read.

### `.autoOrient()` before stripping metadata — because stripping is the default

## Why the ticket's stated defence does not work

The original framing was: serve uploads from a separate origin with no cookies, plus
`X-Content-Type-Options: nosniff`, and *"that single line is the difference between a file-sharing
feature and a stored-XSS hole."*

**`nosniff` does not do that.** It prevents the browser from *correcting* a mislabelled type — it
stops the browser deciding your `text/plain` is secretly HTML. It does nothing about a server that
honestly serves `Content-Type: text/html`, which is exactly the case that matters. OWASP's header
advice works because it is paired with serving a safe type or `Content-Disposition: attachment`; the
header reinforces a decision somebody already made.

And a **bare subdomain is not a separate origin**. `media.example.com` cannot reach
`app.example.com`'s DOM, but it shares the registrable domain and can set cookies scoped to
`.example.com` unless the `Domain` attribute is narrowed and `__Host-` prefixes are used.

### The defence that actually works

**The raw bytes never reach a browser.**

If the worker rejects anything outside an image allowlist, an uploaded HTML file is not "served
carefully" — it is never served at all. The dangerous object has no URL. `nosniff` and a separate
origin then become reinforcement rather than the belt, and the actual belt is the sniff plus the
allowlist, which the pipeline already had.

This is the whole lesson: the ticket had the right defence in hand and did not recognise it, because
it was looking for a header rather than asking **what should ever be reachable**.

## Why the signing layer cannot help

The plan was to check declared size at presign *and* actual size at the worker. **The first half does
not exist.**

R2 has no `content-length-range`, no extension constraint, and `PutBucketPolicy` is **unimplemented**,
so there is no second layer either. POST policy uploads — the feature that carries content-length
constraints — are not supported at all, which is the underlying reason.

The only signing-layer lever is binding `Content-Type` into the signature, and Cloudflare documents
that explicitly — uploads fail `403/SignatureDoesNotMatch` on a mismatch. But the presigned URL
carries `X-Amz-Content-Sha256=UNSIGNED-PAYLOAD`: **the header is bound, the bytes are not.** A client
can upload PNG bytes declaring `image/png`, or HTML bytes declaring `image/png`.

So: **every validation lives in the worker**, and size is enforced after the bytes have already been
stored. That is a real cost — a hostile client can put a large object in the bucket before anyone
refuses it — and the mitigation is lifecycle-based: reject and delete in the worker, and let bucket
lifecycle rules catch what the worker never sees.

## Why `sharp`, precisely

The original reasoning was that Bun's native image API "still has open gaps around colour management."
The gap is real; the label was wrong.

`Bun.Image` exists and is good — it shipped in v1.3.14, and Bun's own release notes claim **ICC
profiles survive transcoding**. But the reference documentation exposes **no colour-management API at
all**: no `toColourspace()`, no `withIccProfile()`, no `pipelineColourspace()`. `metadata()` returns
only width, height and format.

For this pipeline the requirement is *convert to sRGB and strip the ICC profile*, and `Bun.Image`
cannot express it. `sharp` does — **conversion to sRGB is its default**, along with metadata removal,
and it exposes `toColourspace()`, `withIccProfile()` and `keepIccProfile()` for the cases that need
them.

The wider-gamut worry about screenshots does not arise, because we do not accept screenshots as a
category.

## Consequences

- **A decompression bomb is a live denial-of-service against the worker**, so pixel limits must be
  set deliberately and *well below the default*. `sharp` defaults `limitInputPixels` to 268,402,689 —
  a quarter-gigapixel — and its documentation is explicit that it "assumes image dimensions contained
  in the input metadata can be trusted", making it a header-level guard rather than an
  allocation-proof one. Set it for a chat, not a print shop.
- **Orientation is lost silently if `autoOrient()` is omitted**, because metadata stripping is sharp's
  default. ImageMagick states the failure in exactly these terms: *"If the EXIF profile was previously
  stripped, the `-auto-orient` operator will do nothing."* There is no error, no warning, and every
  portrait photo is wrong.
- **Presigned URLs are bearer tokens, valid until expiry**, and R2 documents that they work only on
  the S3 API domain. Expiry is short; a leaked URL is a leaked URL.
- **Failure needs a defined terminal state.** The worker flips a record to `failed` on timeout, which
  is what gives the interface a retry affordance instead of an image that never loads.
- **Avatars use the identical pipeline.** Better Auth hosts no avatar of its own, which is a feature
  here: one thumbnail pipeline serves both profile pictures and message attachments.
- **Deletion needs a scheduled job, not a cascade.** Media outlives its message row deliberately, so
  unreferenced objects are removed by an auditable purge process rather than an accidental cascade.

## What would reverse this

**The three-variant shape is the part most likely to change.** Four sizes, or a blurhash-style
placeholder generated at ingest, are both cheap to add — a column and a worker branch. What is
expensive is changing the *storage decision*, because R2's free egress is the entire reason it was
chosen and moving means re-deriving which cost actually matters.

**`sharp` is not permanent, only correct today.** `Bun.Image` closing the colour-management gap would
make the native path attractive for a service that already runs Bun. It is worth re-checking rather
than assuming, which is why the reasoning above is stated as "cannot express sRGB conversion today"
rather than "Bun is worse".