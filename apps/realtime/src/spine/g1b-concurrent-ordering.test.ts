/**
 * **G1b — the half of gate G1 that needs a real Postgres, and has never run.**
 *
 * `send.test.ts` is G1a: it proves the send path ISSUES the lock, inside the
 * transaction, before the insert. That runs everywhere. This file proves the other
 * half — that concurrent sends into one conversation commit in `seq` order — and it
 * cannot run here, so it says so rather than appearing to pass.
 *
 * ── why it cannot run here ────────────────────────────────────────────────────
 *
 * This machine has no Postgres server binary, no Docker, no podman and no root.
 * The only database is PGlite — Postgres compiled to WASM, served over a single
 * connection by `scripts/db-local.ts`. Two genuinely concurrent transactions there
 * do not RACE: the second one WAITS for the first, which is exactly why the
 * harness pins the pool to one connection. So:
 *
 *   - a concurrency test written naively HANGS rather than fails, and
 *   - a concurrency test that somehow does complete has proved nothing, because
 *     the interleaving it needed never happened.
 *
 * `testDb.kind` says which one this is. The test skips on `pglite` and runs the
 * moment `TEST_DATABASE_URL` points at a real server — Neon included.
 *
 * ── a skip that cannot be mistaken for a pass ─────────────────────────────────
 *
 * The test NAME carries the gap, because that is what the test runner prints, and
 * a non-skipped sibling prints a banner in the same terms. Neither is a passing
 * test that happens to be silent: one is a visible `(skip)` line that says the
 * guarantee is unverified, and the other says it in the output.
 *
 * **A G1b that has never run is not a pass.** `docs/plans/stage-3.md` says so, and
 * nothing in stage 3 may describe the ordering guarantee as proven while this is
 * unrun.
 *
 * ── what it would prove, and what it would not ───────────────────────────────
 *
 * It fires N sends at one conversation at once and records the order their
 * transactions were acknowledged. Under ADR 0005's lock, only one insert per
 * conversation is ever in flight, so that order MUST be increasing in `seq`.
 * Without the lock, two transactions can take positions 100 and 101 and commit in
 * the other order — and that is what the assertion is aimed at.
 *
 * A limit worth stating plainly: a race that does not fire is not a failure, so
 * this is a probabilistic detector and G1a is the deterministic one. They are not
 * substitutes for each other, which is why the plan makes them two tests.
 *
 *     bun run test
 *     TEST_DATABASE_URL=postgres://… bun run test      # and then this really runs
 */
import { beforeEach, expect, test } from 'bun:test';
import { sql, testDb } from '@vartalap/database/test-harness';
import { sendMessageRequest } from '@vartalap/protocol';
import { sendMessage } from './send.ts';
import { directConversationBetweenTwo, newMessageId } from './fixture.ts';

/** Enough concurrent sends that a scheduler is likely to interleave them. */
const CONCURRENT_SENDS = 8;

/**
 * A hang on a target that cannot run this test must become a visible failure, not
 * a wedged `bun test`. It is also the bound on a real server, where N sends are
 * millisecond-scale and anything near this means something is wrong.
 */
const TIMEOUT_MS = 30_000;

const IS_SINGLE_CONNECTION = testDb.kind === 'pglite';

const UNVERIFIED = [
  '',
  '════════════════════════════════════════════════════════════════════',
  '  G1b HAS NEVER RUN. The ordering guarantee is UNVERIFIED.',
  '',
  '  Gate G1 is "within a conversation, commit order equals seq order".',
  `  Its half that runs here (G1a) asserts the send path ISSUES`,
  '  pg_advisory_xact_lock with ADR 0056\'s derivation, inside the',
  '  transaction that inserts the message, before the insert.',
  '',
  '  Its other half — genuinely concurrent sends into one conversation,',
  '  asserting no inversion — needs a real Postgres. This machine has',
  '  only PGlite, which serves one connection: a second transaction',
  '  WAITS rather than racing, so a test written naively hangs and a',
  '  test that somehow finishes has proved nothing.',
  '',
  '  Set TEST_DATABASE_URL at a real server and it runs.',
  '  Until then, do not describe the ordering guarantee as proven.',
  '════════════════════════════════════════════════════════════════════',
  '',
].join('\n');

beforeEach(async () => {
  await testDb.reset();
});

test.skipIf(IS_SINGLE_CONNECTION)(
  `G1b — REQUIRES REAL POSTGRES, HAS NEVER RUN HERE (target is ${testDb.kind}): the ordering guarantee is UNVERIFIED`,
  async () => {
    const { conversationId, authorId, peerId } = await directConversationBetweenTwo();

    /** The order the database acknowledged each commit in. */
    const commits: { seq: bigint; ordinal: number; body: string }[] = [];
    let ordinal = 0;

    await Promise.all(
      Array.from({ length: CONCURRENT_SENDS }, (_, index) => {
        const request = sendMessageRequest.parse({
          conversationId,
          id: newMessageId(),
          // The client clock is deliberately WILDLY wrong, and in both directions.
          // ADR 0005 forbids sorting on it, and this is the test that says so.
          body: `concurrent-${index}`,
          attachments: [],
          clientCreatedAt: new Date(Date.now() + (index % 2 === 0 ? 1 : -1) * 86_400_000).toISOString(),
        });

        return sendMessage({ authorId: index % 2 === 0 ? authorId : peerId, request }).then((outcome) => {
          if (outcome.kind !== 'created') throw new Error(`expected a created message, got ${outcome.kind}`);
          if (outcome.message.seq === null) throw new Error('a committed message has no position');
          ordinal += 1;
          commits.push({ seq: BigInt(outcome.message.seq), ordinal, body: request.body });
        });
      }),
    );

    expect(commits).toHaveLength(CONCURRENT_SENDS);

    // The claim: sorted by COMMIT order, the positions are strictly increasing.
    // An inversion is a message a client paging backwards would skip forever,
    // which is the whole failure ADR 0005 exists to make impossible.
    const byCommit = [...commits].sort((a, b) => a.ordinal - b.ordinal);
    const positions = byCommit.map((commit) => commit.seq);
    const inversions = positions
      .map((seq, index) => ({ seq, previous: positions[index - 1] }))
      .filter((entry, index) => index > 0 && entry.seq < entry.previous!);

    console.log('  commit order:', byCommit.map((commit) => `${commit.body}@${commit.seq}`).join(' '));
    expect(
      inversions,
      `inversions: ${JSON.stringify(inversions)} in commit order ${positions.join(',')}`,
    ).toEqual([]);

    // And the durable facts agree: one row per send, no position reused, and the
    // conversation's position is the highest one written.
    const rows = await sql<{ n: string; distinct_seq: string }[]>`
      SELECT count(*)::text AS n, count(DISTINCT seq)::text AS distinct_seq FROM message`;
    expect(rows[0]!.n).toBe(String(CONCURRENT_SENDS));
    expect(rows[0]!.distinct_seq).toBe(String(CONCURRENT_SENDS));

    const [conversation] = await sql<{ last_seq: string }[]>`
      SELECT last_seq FROM conversation WHERE id = ${conversationId}`;
    expect(BigInt(conversation!.last_seq)).toBe(positions.reduce((a, b) => (a > b ? a : b)));
  },
  TIMEOUT_MS,
);

// The skip notice lives in the test name above, which is what the runner prints.
// This sibling says the same thing in the output body, so a reader who only sees
// the log still cannot miss it — and it runs ONLY where the guarantee is unrun,
// because on a real Postgres the assertions above ran and there is nothing to
// announce.
test.skipIf(!IS_SINGLE_CONNECTION)('G1b has never run here — the ordering guarantee is UNVERIFIED', () => {
  console.warn(UNVERIFIED);
  expect(testDb.kind).toBe('pglite');
});