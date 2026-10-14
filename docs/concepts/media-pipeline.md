# The media pipeline

Where media trust begins, and the pipeline that earns it. Read after
[the message lifecycle](./message-lifecycle.md), which covers the **Media** and **Attachment** nouns
this document implements.

Decisions are in [`docs/adr/0008`](../adr/0008-media-pipeline.md).

---

## The shape

```
client            application server        worker            R2
  │
  ├─ presign ──────► creates a pending media record,
  │                  returns a short-lived PUT URL
  │
  ├─ upload bytes ────────────────────────────────► object
  │
  ├─ send message referencing the media id
  │
                    (outbox) ────────────► claim ──► sniff, allowlist,
                                                    autoOrient, strip,
                                                    derive 3 variants
                                                    flip to ready or failed
```

The client uploads **directly to R2**, so the application server is never in the bandwidth path. Its
job ends at signing a URL.

R2 is the storage choice for **egress**, not price. A busy conversation replays hundreds of thumbnail
URLs per user per session; at ordinary S3 egress rates a terabyte of thumbnail reads is real money,
and R2's egress is free.

---

## The raw upload is never served

**This is the whole security model, and it is one sentence: the bytes a stranger supplied never reach
a browser.**

The worker sniffs the uploaded bytes and accepts only an allowlist of image types. What it emits —
`thumb`, `preview`, `full` — is derived from pixels the worker decoded itself. The original object has
no URL anyone is given.

If someone uploads an HTML file with a script in it, it is not "served carefully". It is **not
served**.

### What `nosniff` actually does, and why it isn't the defence

The intuitive answer is: separate origin, plus `X-Content-Type-Options: nosniff`, and that's the
story. That is wrong in a way worth stating, because the header looks so much like a lock.

`nosniff` prevents the browser from **correcting** a mislabelled type — it stops a browser deciding
your `text/plain` is secretly HTML. It does **nothing** about a server that honestly serves
`Content-Type: text/html`, which is precisely the case that matters. OWASP's header guidance works
because it is paired with serving a safe content type, or with `Content-Disposition: attachment`. The
header reinforces a decision somebody already made.

And a bare subdomain is not a full origin boundary. `media.example.com` cannot reach
`app.example.com`'s DOM, but it shares the registrable domain and can still set cookies scoped to
`.example.com` unless `Domain` is narrowed and `__Host-` prefixes are used.

### What we do instead

1. **Sniff server-side and allowlist.** The declared type is irrelevant — the client's header, the
   type bound into the signature, and the copy in the database were all influenced by the client.
2. **Serve only derived variants**, from a dedicated origin.
3. **`Content-Disposition: attachment`** on anything outside the allowlist.
4. **`nosniff` anyway**, now reinforcement rather than the belt.

---

## The signing layer cannot validate anything

A presigned URL signs a promise about **what the client said**. Cloudflare documents one useful
lever — putting `Content-Type` in the SDK parameters puts it in the signature, so a mismatched
upload fails `403/SignatureDoesNotMatch`. But the URL carries
`X-Amz-Content-Sha256=UNSIGNED-PAYLOAD`: **the header is bound, the bytes are not.**

And there is nothing else:

| constraint | available at signing? |
|---|---|
| content type header | yes — header only, not content |
| content length | **no** — no `content-length-range` equivalent |
| file extension | **no** |
| bucket policy as a second layer | **no** — `PutBucketPolicy` is unimplemented |
| POST policy (which carries length limits) | **no** — not supported at all |

So every real check lives in the worker, and **size is enforced after the bytes have already been
stored**. A hostile client can put a large object in the bucket before anyone refuses it. The
mitigation is lifecycle-based: the worker rejects and deletes, and bucket lifecycle rules catch
whatever the worker never sees.

Also worth knowing: a presigned URL is a **bearer token valid until expiry**, and they work only on
the S3 API domain.

---

## Orientation, and the bug hiding in the default

**`.autoOrient()` first. Strip metadata after — though with `sharp`, stripping is what you get by
default.**

The failure mode is specific and completely silent. `sharp` removes all metadata on output,
*including EXIF-based orientation*, unless you opt back in. So the path of least resistance —
re-encode and write a thumbnail — **throws the orientation tag away without an error**, and every
portrait photo renders rotated.

ImageMagick states it exactly: *"If the EXIF profile was previously stripped, the `-auto-orient`
operator will do nothing."* No warning; just a wrong number.

Do **not** call `withMetadata()` or `keepMetadata()` here. They preserve EXIF, which would also
preserve the GPS coordinates in every photo anyone uploads.

---

## Colour, and which processor

**`sharp`.**

Not because Bun is worse in general — `Bun.Image` shipped in v1.3.14 and is genuinely good, and Bun's
release notes claim ICC profiles survive transcoding. But the requirement here is *convert to sRGB and
strip the ICC profile*, and **`Bun.Image`'s reference documentation exposes no colour-management API
at all** — no `toColourspace()`, no `withIccProfile()`, no `pipelineColourspace()`. Its `metadata()`
returns width, height and format.

`sharp` does the job, and by default: **output is converted to sRGB and metadata is removed** unless
you ask otherwise.

The screenshot worry doesn't apply — we don't accept screenshots as a category.

---

## Decompression bombs

A hostile image can declare small dimensions and expand to gigabytes, and the thumbnail worker is the
target.

`sharp`'s `limitInputPixels` defaults to **268,402,689** — a quarter-gigapixel — and its docs warn it
*"assumes image dimensions contained in the input metadata can be trusted"*, making it a header-level
guard rather than an allocation-proof one.

**Set it far below the default**, for a chat app rather than a print shop. `failOn: 'warning'` and a
CPU `timeout` come from the same page, and both are worth setting.

---

## Variants, and where the worker runs

**Three variants as fixed columns** — `thumb`, `preview`, `full`.

The count is decided at design time and never varies per image. A JSON variants column buys
flexibility nobody will use and costs a lookup on every read. Resizing on read is ruled out for the
same reason R2 was chosen: it turns a busy conversation into a bandwidth bill.

**A separate worker process**, reading claims from Postgres — not inside the realtime server, because
one slow thumbnail must never block message delivery. A full queue is more system than v1 needs; the
map already runs a Postgres transactional outbox, and this reuses that shape.

### Client-side optimisation, and the boundary

Downscale and re-encode **before** upload. It cuts bandwidth and storage for most phone photos, and it
costs nothing in trust, because the worker re-verifies regardless.

The line to hold: *"we already optimised it client-side"* is never a reason to skip server-side
validation. It is a reason the client did some work.

---

## Failure and deletion

A worker that never finishes must say so. The record flips to **`failed`** on timeout, which is what
gives the interface a retry affordance instead of an image that silently never loads.

Media outlives its message row deliberately — a message may be deleted while its media is still
referenced, and the reverse — so **removal is a scheduled, auditable purge of unreferenced objects**,
not a database cascade. The two diverge by design; a cascade is how a bucket ends up with orphans
nobody can account for, or with objects deleted that something still points at.