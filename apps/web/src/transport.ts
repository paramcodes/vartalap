/**
 * The wire, behind one interface.
 *
 * `apps/web` has no HTTP client dependency and no server to talk to in its tests,
 * and that is the point: **every test in this package runs against a transport
 * double** (`fake-transport.ts`). PGlite serves one connection and a live server
 * would put a database, a session and a sign-up budget between the client and its
 * own assertions — Better Auth allows exactly three sign-ups per test run and a
 * test that signs up per test dies partway through on a limit that has nothing to
 * do with what it is testing (decision-index trap 17).
 *
 * `fetch` is the implementation, because `XMLHttpRequest`, `ky`, `axios` and
 * `openapi-fetch` are all four dependencies to express four verbs. Nothing in this
 * interface needs more than that.
 *
 * ── why reads throw and sends do not ───────────────────────────────────────
 *
 * A read that did not happen has no partial answer, and its caller must not be
 * able to mistake a failure for a short page — a short page is what says "you are
 * caught up". So {@link Transport.catchUp} and {@link Transport.history} throw.
 *
 * A send is different, and the difference is the composer document's: **every
 * send outcome is a row state**, and the client cannot choose one without reading
 * the server's answer. So `sendMessage` RETURNS a discriminated union rather than
 * throwing — including the `unreachable` case, which is ambiguous by construction
 * (the message may well have committed) and is the one the idempotency key exists
 * for.
 */
import {
  catchUpPage as catchUpPageSchema,
  errorEnvelope,
  historyPage as historyPageSchema,
  sendMessageResponse,
  type CatchUpPage,
  type CatchUpQuery,
  type ErrorBody,
  type HistoryPage,
  type HistoryQuery,
  type SendMessageRequest,
  type SendMessageResponse,
} from '@vartalap/protocol';

export type SendAnswer =
  | { readonly kind: 'accepted'; readonly response: SendMessageResponse }
  | { readonly kind: 'refused'; readonly status: number; readonly error: ErrorBody }
  /** No answer at all: a network error, a timeout, a DNS failure. Ambiguous. */
  | { readonly kind: 'unreachable' };

export interface Transport {
  sendMessage(request: SendMessageRequest): Promise<SendAnswer>;
  catchUp(query: CatchUpQuery): Promise<CatchUpPage>;
  history(query: HistoryQuery): Promise<HistoryPage>;
}

export interface FetchTransportOptions {
  readonly baseUrl: string;
  /** Injected so a test can drive this too. Defaults to the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** `POST /api/conversations/{id}/messages` — ADR 0059. */
const SEND_PATH = (conversationId: string): string =>
  `/api/conversations/${conversationId}/messages`;

/**
 * `GET /api/conversations/{id}/history` — and the conversation goes in the
 * **query as well as the path**, because `query.ts` on the server compares the two
 * and answers `400` when they disagree. A client that omits it gets a refusal for
 * a conversation it named correctly in the path, and the redundancy that looks
 * like waste is exactly the same insurance ADR 0059 gives it.
 */
const HISTORY_PATH = '/api/conversations/{id}/history';

/** `GET /api/catch-up?after=…` — one query for the whole account (ADR 0005). */
const CATCH_UP_PATH = '/api/catch-up';

/**
 * The real transport.
 *
 * `retryable` is read off the envelope and never inferred from the status code —
 * ADR 0059 exists so a client cannot carry a mirrored status table that the
 * server can contradict without anybody noticing.
 */
export function fetchTransport(options: FetchTransportOptions): Transport {
  const send = options.fetch ?? globalThis.fetch;
  if (send === undefined) throw new Error('fetch is not available in this runtime');
  const base = options.baseUrl.replace(/\/$/, '');

  const readJson = async <T>(response: Response, parse: (input: unknown) => T): Promise<T> =>
    parse(await response.json());

  const refused = async (response: Response): Promise<ErrorBody> => {
    const envelope = errorEnvelope.safeParse(await response.json());
    // A refusal we cannot parse is a server fault, not a client decision, and the
    // retryable one is the honest default: an unparseable 4xx retried is a wasted
    // request, an unparseable 5xx not retried is a lost message.
    return envelope.success
      ? envelope.data.error
      : { code: 'internal', message: `unparseable error envelope (${response.status})`, retryable: true };
  };

  return {
    async sendMessage(request: SendMessageRequest): Promise<SendAnswer> {
      let response: Response;
      try {
        response = await send(`${base}${SEND_PATH(String(request.conversationId))}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
      } catch {
        return { kind: 'unreachable' };
      }

      if (!response.ok) return { kind: 'refused', status: response.status, error: await refused(response) };

      const parsed = sendMessageResponse.safeParse(await response.json());
      if (!parsed.success) {
        return {
          kind: 'refused',
          status: response.status,
          error: { code: 'internal', message: 'the send response did not match its schema', retryable: true },
        };
      }
      return { kind: 'accepted', response: parsed.data };
    },

    async catchUp(query: CatchUpQuery): Promise<CatchUpPage> {
      // `after` is required and `'0'` means everything — a missing cursor is a
      // `400` on the server and `catch-up.ts` is what decides that `0`.
      const search = new URLSearchParams({ after: String(query.after), limit: String(query.limit) });
      const response = await send(`${base}${CATCH_UP_PATH}?${search.toString()}`, { credentials: 'include' });
      if (!response.ok) throw new Error(`catch-up answered ${response.status}`);
      return readJson(response, (input) => catchUpPageSchema.parse(input));
    },

    async history(query: HistoryQuery): Promise<HistoryPage> {
      const search = new URLSearchParams({ conversationId: String(query.conversationId) });
      if (query.before !== undefined) search.set('before', String(query.before));
      // `before` and `after` together are refused by the server and must never be
      // sent together from here either — they are cursors for two opposite
      // ORDER BYs, and a request carrying both has not said which way it reads.
      if (query.after !== undefined) search.set('after', String(query.after));
      search.set('limit', String(query.limit));

      const path = HISTORY_PATH.replace('{id}', String(query.conversationId));
      const response = await send(`${base}${path}?${search.toString()}`, { credentials: 'include' });
      if (!response.ok) throw new Error(`history answered ${response.status}`);
      return readJson(response, (input) => historyPageSchema.parse(input));
    },
  };
}