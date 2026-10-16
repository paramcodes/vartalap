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
 *
 * ── testability: numbers, not switches ────────────────────────────────────────
 *
 * This instance is built at module scope, so any knob that has to change between a
 * test run and a deployed process must be read at module scope too — an option object
 * a test mutates after import has already been consumed. Everything below that a test
 * needs to change is therefore an ENVIRONMENT VARIABLE, and the environment is set by
 * a `--preload` in the `test` scripts (`packages/auth/src/test-harness.ts`), which Bun
 * evaluates before any test file and therefore before this one.
 *
 * **Nothing here can disable the limiter.** ADR 0043 and the numbers here are the
 * design; a test that needs twenty sign-ups gets twenty sign-ups through a raised
 * ceiling, not through a limiter that was switched off.
 */
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { username } from 'better-auth/plugins';
import { db } from '@vartalap/database';
import * as schema from '@vartalap/database/schema';

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) throw new Error('BETTER_AUTH_SECRET is required');
if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');

/**
 * **A positive integer from the environment, or `undefined`.**
 *
 * `Number('')` is `0` and `Number('abc')` is `NaN`, and both are ways for a typo in a
 * deployment's environment to become a *silently different* rate limit rather than a
 * startup failure. This returns `undefined` for anything that is not a whole positive
 * number, so the caller keeps its own default and the bad value is visibly ignored
 * rather than honoured.
 */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The sign-up / sign-in ceiling, and the override that lifts it.
 *
 * ⚠️ **The `rateLimit` block below does NOT control sign-up, and reading it as though
 * it does is trap 19 in the decisions index.** Better Auth 1.7.7 ships a hard-coded
 * special rule — `{ window: 10, max: 3 }` — that it applies to any path starting
 * `/sign-up`, `/sign-in`, `/change-password` or `/change-email`, and it applies it
 * AFTER the base rule, overwriting `max: 100`. So the numbers a reader of this file
 * would assume are guarding sign-up are not, and tightening them changes nothing.
 *
 * `customRules` is the only documented lever that is applied last, and this is what it
 * is for. **`customRules` is undefined unless the override environment is set**, which
 * is the whole point: with no override the library's own rule applies and production
 * behaviour is byte-identical to not having this function at all. Writing out
 * `'/sign-up/*': { window: 10, max: 3 }` by default would PIN the library's numbers, so
 * a future release that tightened sign-up to 2 would be silently loosened back to 3
 * by our config — a security regression caused by a config that reads as conservative.
 *
 * The test harness (`packages/auth/src/test-harness.ts`) sets the override, and this
 * instance is built at MODULE SCOPE, so the override has to be in the environment
 * before this file is evaluated. That is what the preload in the `test` scripts is for.
 */
const SIGN_UP_LIMIT_OVERRIDE: { window: number; max: number } | undefined =
  process.env.AUTH_RATE_LIMIT_SIGN_UP_MAX === undefined &&
  process.env.AUTH_RATE_LIMIT_SIGN_UP_WINDOW === undefined
    ? undefined
    : {
        // The window default is Better Auth's own special-rule window (10s), not ours,
        // so setting only the ceiling leaves the shape of the rule alone.
        window: positiveInt('AUTH_RATE_LIMIT_SIGN_UP_WINDOW', 10),
        max: positiveInt('AUTH_RATE_LIMIT_SIGN_UP_MAX', 3),
      };

export const auth = betterAuth({
  appName: 'vartalap',
  secret,
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
  trustedOrigins: [
    'http://localhost:3000',
    'http://localhost:4173',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:4173',
    'http://127.0.0.1:5173',
  ],

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
    //
    // ADR 0043 exists and this limiter is real; it is never disabled to make a test
    // pass. Only its NUMBERS are overridable, and only from the environment. See
    // SIGN_UP_LIMIT_OVERRIDE above for why `max: 100` says nothing about sign-up.
    enabled: true,
    window: positiveInt('AUTH_RATE_LIMIT_WINDOW', 60),
    max: positiveInt('AUTH_RATE_LIMIT_MAX', 100),
    /**
     * `undefined` in every environment that does not set the override. See the
     * comment on SIGN_UP_LIMIT_OVERRIDE for why it is not written out by default.
     *
     * `/sign-up/*` rather than `/sign-up`: the library matches its own special rule
     * with `path.startsWith`, while `customRules` keys are exact or `*`-wildcarded,
     * and the path it sees is the one relative to `baseURL` — `/sign-up/email`.
     */
    customRules: SIGN_UP_LIMIT_OVERRIDE === undefined ? undefined : { '/sign-up/*': SIGN_UP_LIMIT_OVERRIDE },
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
