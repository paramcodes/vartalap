/**
 * The smallest Redis client that can hold presence, and nothing else.
 *
 * Four commands: `SETEX`, `GET`, `MGET`, `DEL` — the exact surface
 * `presence.ts` needs — plus `PING` and `PTTL` so a test can prove the TTL is
 * real rather than assumed. RESP2 over a `Bun` TCP socket, ~130 lines, no
 * dependency.
 *
 * ── why not ioredis ────────────────────────────────────────────────────────
 *
 * `ioredis` is the obvious client and would be the right one the moment the
 * command surface grows past TTL operations — pipelining, clusters, Sentinel,
 * pub/sub for the presence subscription half of ADR 0006. None of those exist
 * yet, and a dependency that exists for a future is a dependency nobody will
 * remove when the future arrives differently. The reversal condition is the
 * command list above: the day presence needs a fifth command family, take
 * `ioredis` and delete this file. `docs/plans/stage-4.md` records the same
 * rule from the plan side.
 *
 * ── correctness notes ──────────────────────────────────────────────────────
 *
 * Redis replies arrive in the order commands were sent, so one FIFO of pending
 * resolvers is the whole demultiplexer. The parser is incremental — a reply
 * split across two TCP segments must not read as two replies — and it handles
 * exactly the five reply shapes this client can receive (`+`, `-`, `:`, `$`,
 * `*`, including `$-1` and `*-1` nulls). Anything else is a bug, and it throws
 * rather than guessing.
 *
 * Every wait has a deadline. A connect that never answers and a command whose
 * reply never arrives both reject instead of hanging — this repository learned
 * on PGlite that a wedged backend plus an undeadlined wait reads as a slow
 * test rather than as a failure (decisions-index trap 19), and this client is
 * not going to re-teach it.
 */
import { type Socket, type SocketHandler } from 'bun';

/** What this client can receive. No nested arrays — `MGET` is flat by construction. */
export type RedisReply = string | number | null | RedisReply[];

export class RedisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisError';
  }
}

export interface RedisOptions {
  /** `redis://host:port`. Anything else (credentials, TLS, db index) is refused loudly. */
  readonly url: string;
  /** Fails a wait instead of hanging. Overridden in tests to keep them short. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function parseUrl(url: string): { hostname: string; port: number } {
  const parsed = new URL(url);
  if (parsed.protocol !== 'redis:') throw new RedisError(`only redis:// URLs, got ${url}`);
  if (parsed.username !== '' || parsed.password !== '') {
    throw new RedisError('authenticated Redis is not configured; refusing rather than ignoring credentials');
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    throw new RedisError('a db index is not configured; refusing rather than silently using db 0');
  }
  return { hostname: parsed.hostname || '127.0.0.1', port: Number(parsed.port || 6379) };
}

function encode(args: readonly (string | number)[]): Uint8Array {
  const parts: string[] = [`*${args.length}\r\n`];
  for (const arg of args) {
    const text = String(arg);
    parts.push(`$${Buffer.byteLength(text)}\r\n${text}\r\n`);
  }
  return Buffer.from(parts.join(''));
}

/** Incremental RESP2 reader. Returns complete replies, keeps the remainder. */
class ReplyReader {
  private buffer = Buffer.alloc(0);

  /** Every complete reply currently in the buffer, in order. */
  pull(): RedisReply[] {
    const replies: RedisReply[] = [];
    for (;;) {
      let reply: RedisReply | undefined;
      try {
        reply = this.tryRead();
      } catch (error) {
        // A reply split across two TCP segments is not an error — it is a
        // reply that has not finished arriving. Anything else is.
        if (error === INCOMPLETE) return replies;
        throw error;
      }
      if (reply === undefined) return replies;
      replies.push(reply);
    }
  }

  feed(chunk: Uint8Array): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
  }

  private tryRead(): RedisReply | undefined {
    if (this.buffer.length === 0) return undefined;
    const type = this.buffer[0];
    if (type === 43) return this.readLine(); // +
    if (type === 45) throw new RedisError(this.readLine() as string); // -
    if (type === 58) return Number(this.readLine()); // :
    if (type === 36) return this.readBulk(); // $
    if (type === 42) return this.readArray(); // *
    throw new RedisError(`unknown RESP type byte: ${type}`);
  }

  private readLine(): string {
    const end = this.buffer.indexOf('\r\n');
    if (end === -1) throw INCOMPLETE;
    const line = this.buffer.subarray(1, end).toString();
    this.buffer = this.buffer.subarray(end + 2);
    return line;
  }

  /**
   * Nothing is consumed until the whole bulk string is present. Peeking the
   * length first is what makes a split reply — length in one segment, body in
   * the next — wait rather than throw.
   */
  private readBulk(): string | null | undefined {
    const end = this.buffer.indexOf('\r\n');
    if (end === -1) return undefined;
    const length = Number(this.buffer.subarray(1, end).toString());
    if (length === -1) {
      this.buffer = this.buffer.subarray(end + 2);
      return null;
    }
    if (this.buffer.length < end + 2 + length + 2) return undefined;
    const body = this.buffer.subarray(end + 2, end + 2 + length).toString();
    this.buffer = this.buffer.subarray(end + 2 + length + 2);
    return body;
  }

  /**
   * Arrays are attempted against a snapshot: an element that has not finished
   * arriving rewinds the whole array rather than consuming half of it. `MGET`
   * replies are flat — a nested array is a protocol violation, not a shape —
   * so there is no recursion to unwind.
   */
  private readArray(): RedisReply[] | null | undefined {
    const snapshot = this.buffer;
    const end = this.buffer.indexOf('\r\n');
    if (end === -1) return undefined;
    const count = Number(this.buffer.subarray(1, end).toString());
    if (count === -1) {
      this.buffer = this.buffer.subarray(end + 2);
      return null;
    }
    const items: RedisReply[] = [];
    try {
      this.buffer = this.buffer.subarray(end + 2);
      for (let index = 0; index < count; index += 1) {
        const item = this.tryRead();
        if (item === undefined || Array.isArray(item)) {
          throw item === undefined ? INCOMPLETE : new RedisError('nested array element in a flat reply');
        }
        items.push(item);
      }
    } catch (error) {
      if (error === INCOMPLETE) this.buffer = snapshot;
      throw error;
    }
    return items;
  }
}

const INCOMPLETE = Symbol('incomplete');

interface Pending {
  readonly resolve: (reply: RedisReply) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class Redis {
  private socket: Socket<unknown> | null = null;
  private readonly reader = new ReplyReader();
  private readonly pending: Pending[] = [];
  private closed = false;

  private constructor(
    private readonly hostname: string,
    private readonly port: number,
    private readonly timeoutMs: number,
  ) {}

  static async connect(options: RedisOptions): Promise<Redis> {
    const { hostname, port } = parseUrl(options.url);
    const client = new Redis(hostname, port, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    await client.open();
    return client;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RedisError(`connect to ${this.hostname}:${this.port} timed out`));
      }, this.timeoutMs);
      const handler: SocketHandler<unknown> = {
        open: (socket) => {
          clearTimeout(timer);
          this.socket = socket;
          resolve();
        },
        data: (_socket, chunk) => this.onData(chunk),
        close: () => this.onClose(new RedisError('connection closed')),
        error: (_socket, error) => this.onClose(error),
        connectError: (_socket, error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      Bun.connect({ hostname: this.hostname, port: this.port, socket: handler }).catch(reject);
    });
  }

  private onData(chunk: Uint8Array): void {
    this.reader.feed(chunk);
    let replies: RedisReply[];
    try {
      replies = this.reader.pull();
    } catch (error) {
      this.onClose(error as Error);
      return;
    }
    for (const reply of replies) {
      const next = this.pending.shift();
      if (next === undefined) {
        this.onClose(new RedisError('reply with nobody waiting for it'));
        return;
      }
      clearTimeout(next.timer);
      next.resolve(reply);
    }
  }

  private onClose(error: Error): void {
    this.closed = true;
    this.socket = null;
    for (const next of this.pending.splice(0)) {
      clearTimeout(next.timer);
      next.reject(error);
    }
  }

  /** One command, one reply. Responses arrive in send order, so callers may overlap. */
  command(...args: readonly (string | number)[]): Promise<RedisReply> {
    if (this.closed || this.socket === null) {
      return Promise.reject(new RedisError('client is closed'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RedisError(`command timed out: ${String(args[0])}`));
      }, this.timeoutMs);
      this.pending.push({ resolve, reject, timer });
      this.socket?.write(encode(args));
    });
  }

  async close(): Promise<void> {
    this.onClose(new RedisError('client is closed'));
    this.socket?.end();
  }
}
