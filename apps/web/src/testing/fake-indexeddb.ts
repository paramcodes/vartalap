/**
 * `fake-indexeddb/auto`, loaded BEFORE anything else in this package's tests.
 *
 * ⚠️ **Why this is a preload file and not an import at the top of each test.**
 * Dexie captures the IndexedDB factory into a **module-level constant**
 * (`var domDeps = { indexedDB: _global.indexedDB || … }`) the first time
 * `dexie/dist/dexie.mjs` is evaluated, and never looks again. A test file whose
 * side-effect import happens to be evaluated after `dexie` therefore gets
 * `Dexie.dependencies.indexedDB === null` and every open fails with
 * `MissingAPIError: IndexedDB API missing` — which reads like a missing
 * dependency and is actually an evaluation-order problem.
 *
 * Preloading fixes it at the only place that can: before any test module's
 * imports are evaluated at all. `apps/web`'s `test` script and the root
 * `bun test` invocation both name it.
 *
 * This is the whole justification for the dependency. A browser has IndexedDB
 * and nothing to do; a headless test needs one, and gate G3 is **only provable
 * with it** — the invariant is that a duplicate own-echo must not create a second
 * row in a real IndexedDB transaction, which a hand-rolled object store cannot
 * demonstrate.
 */
import 'fake-indexeddb/auto';