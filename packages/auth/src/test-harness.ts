/**
 * The auth test harness. **A preload, and that is the whole mechanism.**
 *
 *     bun test --preload ./packages/auth/src/test-harness.ts \
 *                --preload ./packages/database/src/test-harness.ts
 *
 * ⚠️ **Why this file has to be a preload and not a `beforeAll`.**
 *
 * `packages/auth/src/auth.ts` calls `betterAuth({...})` at MODULE SCOPE, and it reads
 * `AUTH_RATE_LIMIT_SIGN_UP_*` at module scope too. A `beforeAll` in a test file runs
 * long after every import in that file has been evaluated, so by the time a hook set
 * the variable the instance had already been built with the old numbers — and the
 * symptom is not an error, it is three sign-ups succeeding and the fourth answering
 * `429` for the rest of the run.
 *
 * `--preload` is the only hook Bun offers that runs before module evaluation of the
 * files under test, so it is the only one that can express "before `auth` is
 * imported". This file therefore has no exports and no functions: importing it is the
 * entire effect.
 *
 * ⚠️ **How the ordering is guaranteed, and how that guarantee is checked.**
 *
 * A comment cannot guarantee a preload order; a test can. `src/server.test.ts` signs
 * up more times than trap 17 says are permitted in one window and asserts every
 * response is `200`. That test is the guarantee: if this preload is dropped from a
 * `test` script, reordered behind something that imports `@vartalap/auth`, or the env
 * names drift apart between here and `auth.ts`, the fourth sign-up is a `429` and the
 * test fails. It is a behavioural proof that the module saw the variable, not a
 * reading of a preload list.
 *
 * ── what is being raised, and what is not ─────────────────────────────────────
 *
 * Better Auth 1.7.7 hard-codes `{ window: 10, max: 3 }` for `/sign-up*` and applies
 * it AFTER `rateLimit.max`, so the repository's `max: 100` never governed sign-up
 * (decisions index, trap 19). Four test files each sign up once, so the run is one
 * request away from a failure that has nothing to do with what those files test.
 *
 * **The limiter is not disabled — ADR 0043's numbers are the design and they stay.**
 * `AUTH_RATE_LIMIT_SIGN_UP_MAX` overrides the special rule through `customRules`, and
 * a deliberately enormous ceiling is right here: the thing being measured is the
 * spine, and a test that is silently refused half way through reports a rate-limit
 * `429` as a broken receipt path. `100_000` is far past anything a test run can reach,
 * which means "no ceiling is reachable" rather than "a higher ceiling exists".
 *
 * Only the sign-up path is overridden. Every other path keeps whatever numbers
 * Better Auth resolves, so this file cannot quietly widen anything it did not measure
 * a failure in.
 */

const MAX = '100000';

process.env.AUTH_RATE_LIMIT_SIGN_UP_MAX ??= MAX;
process.env.AUTH_RATE_LIMIT_SIGN_UP_WINDOW ??= '10';

export {};
