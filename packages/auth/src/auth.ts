/**
 * Self-hosted Better Auth, pointed at the same Postgres as everything else
 * (ADR 0001, 0004). There is no second database and no mirror of `user`: it is
 * our table, and presence and read state are derived rather than copied.
 *
 * Verified against better-auth 1.7.7, reading the published package source rather
 * than the docs, which are served unversioned from `latest` and already disagree
 * with the code in two places this file depends on:
 *
 *   - The Drizzle adapter has moved out of core into `@better-auth/drizzle-adapter`.
 *     `better-auth/adapters/drizzle` still re-exports it, so older guides work, but
 *     the dependency is named separately and versioned on its own train.
 *   - The CLI writes `auth-schema.ts`, not `schema.ts`. The CLI docs say otherwise.
 *
 * What this library does NOT do here, because it matters:
 *
 *   - It never issues DDL through the Drizzle adapter. `migrate` is hard-gated to
 *     the built-in Kysely adapter. Tables come from our migrations, in our order.
 *   - It does not normalise `username` at the database level. It lowercases in
 *     application code, and ADR 0001 already established that a writer using Drizzle
 *     directly skips that. The expression index on `user.username` and the
 *     reservation trigger are what make the guarantee real rather than intended.
 *   - `immutableUsername: true` below is application-layer only, and only on
 *     `POST /update-user`. A direct SQL update bypasses it. The BEFORE UPDATE
 *     trigger in 0003_handle_reservation.sql is the real enforcement.
 *
 * Schema validation (new in 1.7.x, on by default in production) reads the Drizzle
 * schema object rather than the database, so it catches config drift and not
 * unapplied migrations. `bun run auth:check` runs the same diff offline.
 */
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { username } from 'better-auth/plugins';
import { db } from '@vartalap/database';
import * as schema from '@vartalap/database/schema';

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) throw new Error('BETTER_AUTH_SECRET is required');
if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');

export const auth = betterAuth({
  appName: 'vartalap',
  secret,
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',

  database: drizzleAdapter(db, {
    provider: 'pg',
    // Keyed by MODEL name. Our exports happen to be `user`, `session`, `account`
    // and `verification`, which are also the defaults — but the adapter looks up
    // the export, not the SQL table, so spreading the module in is load-bearing.
    schema,
  }),

  user: {
    additionalFields: {
      // Better Auth's own `name` is the ACCOUNT display name — what a member sees
      // before they have a per-conversation one. `member.display_name` is the
      // override inside a Conversation; both exist, exactly as in the product this
      // is modelled on. The column was added to `user` because Better Auth
      // validates its existence on every request and auth is down with a 500
      // without it — not because it was invented here.
      //
      // `image` is genuinely dead. Avatars are Media through ADR 0008's pipeline
      // and live in `avatar_media_id`; nothing may write this column.
      image: { type: 'string', required: false, input: false, returned: false },
    },
  },

  // A Handle is the login. Email exists only because Better Auth has no
  // handle-only credential path, and it is mandatory on the signup body — the same
  // finding that made `user.email` NOT NULL. Email is never shown, never mailed
  // to, and never used to sign in.
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    // Handle-or-email on the sign-in screen. Both resolve to one `user` row, so
    // this stays one query against `user_username_unique` / `user_email_key`.
    autoSignIn: true,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    // Deliberately NOT enabled. cookieCache keeps a revoked session alive on other
    // devices until the cache expires, which is a correctness bug against a
    // "revoke this device now" control that ADR 0022 asks for.
    cookieCache: { enabled: false },

    additionalFields: {
      // ADR 0022 device scope. Core `listSessions` already returns every non-expired
      // session with ipAddress and userAgent, so this is the only thing needed to
      // name a device; `updateSession` writes only these fields and rejects core ones.
      deviceLabel: { type: 'string', required: false, input: false },
      deviceTrusted: { type: 'boolean', required: false, input: false, defaultValue: false },
    },
  },

  rateLimit: {
    // Memory storage is correct here: one self-hosted process, no serverless
    // fan-out. If this ever runs on more than one instance, move it to
    // `customStorage` or `secondary-storage` or the counters are per-instance.
    //
    // Note this only limits client-initiated HTTP. `auth.api.*` called server-side
    // is not limited, so the chat endpoints need their own limiter (ADR 0043).
    enabled: true,
    window: 60,
    max: 100,
  },

  advanced: {
    // Every primary key in this schema is `uuid`. Better Auth's default generator
    // emits a 32-character opaque string, which Postgres rejects with
    // `22P02 invalid input syntax for type uuid` on the first sign-up — and because
    // the failure surfaces as "Failed to create user" it looks like a duplicate
    // handle rather than an id-shape problem.
    database: { generateId: 'uuid' },
    // The web app and the auth API are same-origin in v1. If they are ever split,
    // sameSite 'none' + secure is required and this default will silently break it.
    defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
    disableCSRFCheck: false,
  },

  disabledPaths: ['/is-username-available'],

  plugins: [
    username({
      minUsernameLength: 3,
      // ADR 0017. The default is 30; the handle alphabet is `^[a-z0-9_]{3,20}$`.
      maxUsernameLength: 20,
      usernameValidator: (u) => /^[a-z0-9_]{3,20}$/.test(u),
      usernameNormalization: (u) => u.toLowerCase(),
      // Without this the validator runs BEFORE lowercasing, so "Param" is rejected
      // for containing a capital — the user's own display casing fails sign-up.
      validationOrder: { username: 'post-normalization' },
      // Application-layer only, and only on POST /update-user. The database is
      // what actually makes a handle immutable.
      immutableUsername: true,
      displayUsername: true,
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
export type AuthUser = typeof auth.$Infer.Session.user;
