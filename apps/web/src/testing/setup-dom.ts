/**
 * happy-dom globals for component tests, loaded as a `--preload` BEFORE any
 * test module — same reason as `fake-indexeddb.ts`: `@testing-library/react`
 * reads `document` at import time, and a test file that imports it before the
 * globals exist gets `document is undefined` rather than a component.
 *
 * Preload order in `package.json`: this file first, then `fake-indexeddb.ts`.
 * Non-component tests are unaffected — they gain inert `window` globals.
 */
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost/' });

const globals: Record<string, unknown> = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Text: window.Text,
  Event: window.Event,
  CustomEvent: window.CustomEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  FocusEvent: window.FocusEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
};

for (const [key, value] of Object.entries(globals)) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) {
    (globalThis as Record<string, unknown>)[key] = value;
  }
}

/**
 * Dexie resolves the IndexedDB factory through `window` when one exists, and
 * happy-dom ships no `indexedDB` — so with these globals present Dexie
 * captures `undefined` even while `globalThis.indexedDB` (fake-indexeddb) is
 * set. Bridge the factory and its companion classes onto the window before
 * any test module evaluates `dexie`. This is why this preload runs AFTER
 * `fake-indexeddb.ts` in the `test` scripts.
 */
for (const key of [
  'indexedDB',
  'IDBKeyRange',
  'IDBRequest',
  'IDBDatabase',
  'IDBObjectStore',
  'IDBTransaction',
  'IDBIndex',
  'IDBCursor',
  'IDBVersionChangeEvent',
]) {
  const value = (globalThis as Record<string, unknown>)[key];
  if (value !== undefined && (window as unknown as Record<string, unknown>)[key] === undefined) {
    (window as unknown as Record<string, unknown>)[key] = value;
  }
}
