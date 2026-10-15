/**
 * The structural guarantee, asserted rather than asserted-to.
 *
 * `message-lifecycle.md` §8 says "One write path, no exceptions", and the reason
 * it needs saying is that a code review is a convention and a duplicate in the
 * transcript is invisible until somebody sends from two tabs.
 *
 * So this file reads the package's own source and fails if the module graph stops
 * guaranteeing what the comments claim:
 *
 * 1. **`store.ts` is the only module that imports Dexie**, and it is the only place
 *    a second write path could be written — the database handle is a
 *    module-private `const` and is not exported.
 * 2. **The store's public surface is exactly what is written down here.** A new
 *    method is a failing test, which is what turns "add another writer" from a
 *    review comment into a red build.
 * 3. **The one receive write path has exactly three call sites** — a live frame, a
 *    catch-up row, and a send response — which is what `message-lifecycle.md` §8
 *    enumerates.
 * 4. **Nothing outside a test imports the transport double.** A fake that a
 *    production path can reach is a fake somebody will ship.
 *
 *     bun test apps/web
 */
import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageStore } from './store.ts';

const SRC = new URL('./', import.meta.url).pathname;

/**
 * Every `.ts` under `src/` as `{ name, source }`.
 *
 * This file is in the directory and every assertion below greps the source text, so
 * it excludes ITSELF — a guard that reads its own pattern and passes is worse than
 * no guard.
 */
async function sources(): Promise<{ name: string; source: string }[]> {
  const names = (await readdir(SRC)).filter((name) => name.endsWith('.ts')).sort();
  return Promise.all(
    names.map(async (name) => ({ name, source: await readFile(join(SRC, name), 'utf8') })),
  );
}

/** The files under test: everything except the tests, including this one. */
async function productionSources(): Promise<{ name: string; source: string }[]> {
  return (await sources()).filter(({ name }) => !name.endsWith('.test.ts'));
}

/**
 * Source with its comments removed.
 *
 * Every one of these files is mostly comment — that is the house style and it is
 * right — and a comment saying "the client may not assign `seq`" is not the client
 * assigning one. Stripping comments first is what keeps the greps below honest
 * rather than merely noisy.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * The whole public surface of the store, written down.
 *
 * Every write to durable state is a method here, so this list is the complete set
 * of things a caller can do to the database. It is short on purpose: the bias is
 * deletion, and a method nobody could justify against this list does not get added.
 */
const STORE_SURFACE = [
  'applyLocalSend',
  'applyReceived',
  'applyReceipt',
  'applyDelivery',
  'attemptsOf',
  'clearDiscrepancy',
  'close',
  'conversationsWithPositionedRows',
  'cursor',
  'delete',
  'deliveryFor',
  'discrepancies',
  'draftFor',
  'heldThrough',
  'isReadByOthers',
  'lowestPosition',
  'markFailed',
  'markInFlight',
  'messageById',
  'moveCursorTo',
  'noteDiscrepancy',
  'open',
  'ownReadThrough',
  'positionedCount',
  'queuedSends',
  'receiptFor',
  'reclaimInFlight',
  'releaseToQueued',
  'resetAttempts',
  'rowsFor',
  'setDraft',
].sort();

describe('one write path, structurally', () => {
  test('a second writable handle is a red test, not a review question', async () => {
    // The inverse of the guarantee above, stated the way this repo prefers:
    // add a constructor call anywhere but `store.ts` and this fails.
    const offenders = (await productionSources())
      .filter(({ name }) => name !== 'store.ts')
      .filter(({ source }) => /new\s+VartalapDatabase/.test(code(source)))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  test('`store.ts` holds the only database handle', async () => {
    // The hazard is a SECOND WRITABLE HANDLE, not any mention of Dexie. Since
    // 6.3 the transcript subscribes through `liveQuery`, which needs no handle
    // of its own — it takes a table the store returns. What must remain true is
    // that only `store.ts` can create one, which is greppable exactly:
    //   • a constructor call   — `new VartalapDatabase(…)`
    //   • the private field    — the shape only the store's own constructor writes
    //   • a table assignment   — `x.messages = …`, which would make a handle
    const handles = (await productionSources())
      .filter(({ source }) => {
        const code_ = code(source);
        return (
          /new\s+VartalapDatabase/.test(code_) ||
          /#db\s*:/.test(code_) ||
          /\b(this\.)?(db|#db)\s*\.\s*(messages|drafts|receipts|deliveries|cursor|discrepancies)\s*=/.test(code_)
        );
      })
      .map(({ name }) => name);

    expect(handles).toEqual(['store.ts']);
  });

  test('the database handle is not exported out of `store.ts`', async () => {
    // The structural half of the guarantee: the database is a module-private field
    // on a class whose instance is only ever made by `createStore`, so no other file
    // in this package can reach a handle on it even if somebody decides they want one.
    const store = (await sources()).find(({ name }) => name === 'store.ts');
    expect(store?.source).toContain('readonly #db: VartalapDatabase;');
    expect(/export\s+(declare\s+)?class\s+VartalapDatabase/.test(store?.source ?? '')).toBe(false);
  });

  test('the store’s public surface is exactly the one written down', () => {
    const actual = Object.getOwnPropertyNames(MessageStore.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(actual).toEqual(STORE_SURFACE);
  });

  test('the one receive write path has exactly three call sites', async () => {
    const callers = (await productionSources())
      .filter(({ source }) => source.includes('.applyReceived('))
      .map(({ name }) => name);

    // `message-lifecycle.md` §8: live over the socket, back from catch-up
    // pagination, and the sender's own message echoing home.
    expect(callers.sort()).toEqual(['catch-up.ts', 'live.ts', 'send.ts']);
  });

  test('nothing outside a test imports the transport double', async () => {
    const importers = (await productionSources())
      .filter(({ source }) => code(source).includes("from './fake-transport.ts'"))
      .map(({ name }) => name);

    expect(importers).toEqual([]);
  });

  test('no module but the store and the server double assigns a position', async () => {
    // "The client may not interpolate a provisional position." One grep: a row
    // literal carrying a `seq` the caller made up.
    //
    // The two exclusions are both named rather than convenient. `store.ts` is where
    // a position is written at all — from the row's own `seq`, never from a value it
    // computed. `fake-transport.ts` is the SERVER double: it allocates from the
    // sequence, which is the server's job and the reason this client's numbers are
    // real ones.
    const offenders = (await productionSources())
      .filter(({ name }) => name !== 'store.ts' && name !== 'fake-transport.ts')
      // ⚠️ `\s*` is inside the negative lookahead on purpose. Written as `seq:\s*(?!…)`
    // the regex backtracks `\s*` to zero, the lookahead is evaluated against the
    // space, everything fails to match, and EVERY `seq:` in the package is an
    // offender — which is the opposite of a guard.
    .filter(({ source }) => /seq:(?!\s*(?:null\b|message\.seq|position\b|seq\b))/.test(code(source)))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  test('no module but the store reaches for a Dexie table', async () => {
    // The belt to `store.ts`'s braces: even a file that somehow got a handle would
    // have to name a table, and that is greppable.
    const offenders = (await productionSources())
      .filter(({ name }) => name !== 'store.ts')
      .filter(({ source }) => /#db\.(messages|drafts|receipts|deliveries|cursor|discrepancies)\b/.test(code(source)))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});