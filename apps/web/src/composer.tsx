/**
 * The composer — unit 6.4, gate T3.
 *
 * Shape and copy come from ADR 0050 (one surface, attach inside, send outside);
 * the three enter-to-send guards from 0051, and `isComposing` is the weakest of
 * them; drafts stay on this device (0049).
 *
 * What this component does NOT own: the send queue. That is `send.ts`, and the
 * composer is a caller of it the way any other caller would be — the rules it
 * must not re-decide (idempotency key, backoff, terminal-vs-retryable) live
 * there and stay there. This renders states; it does not decide them.
 */
import { useEffect, useRef, useState } from 'react';
import type { SendPermission } from '@vartalap/protocol';
import { ClipIcon, SendIcon, SmileIcon } from './icons.tsx';
import { canSend } from './send.ts';
import type { MessageStore } from './store.ts';

export interface ComposerDeps {
  readonly permission: SendPermission;
  /** The conversation the drafts and the sends belong to. */
  readonly conversationId: string;
  /** Called with the text Enter or the send button committed. */
  readonly send: (text: string) => void;
  readonly store?: MessageStore;
}

/** The composer's readable state, and the guard that currently stands. */
export type ComposerState =
  | { readonly kind: 'empty'; readonly reason: 'empty' }
  | { readonly kind: 'locked'; readonly reason: string }
  | { readonly kind: 'ready' };

/**
 * The guard, decided once and read by both affordances — the disabled send
 * button and the `Enter` handler can never disagree about whether there is
 * anything to send (`send.ts`'s own reason for existing).
 */
export function guard(permission: SendPermission, text: string): ComposerState {
  const verdict = canSend({ permission, text });
  if (verdict.allowed) return { kind: 'ready' };
  return verdict.reason === 'empty'
    ? { kind: 'empty', reason: 'empty' }
    : { kind: 'locked', reason: verdict.reason };
}

/**
 * Drafts, device-local. The store's `drafts` table is the only home (0049):
 * a draft in component state dies on the re-render that follows a reload, and
 * a draft on the server is on someone else's device.
 */
export function useDraft(conversationId: string, store: MessageStore | undefined) {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const saving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touched = useRef(false);

  useEffect(() => {
    if (store === undefined) return;
    let cancelled = false;
    void store.draftFor(conversationId).then((row) => {
      if (cancelled) return;
      // The load is async and typing is not: a member who starts typing before
      // the stored draft arrives must not have their first keystrokes replaced
      // by what the store said a moment ago. The stored text is still what the
      // draft becomes once the field is empty, and `loaded` is what lets the
      // debounced write start.
      if (!touched.current) setText(row?.text ?? '');
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId, store]);

  // Debounced write: typing is faster than IndexedDB, and every keystroke is
  // not a transaction.
  useEffect(() => {
    if (!loaded || store === undefined) return;
    if (saving.current !== null) clearTimeout(saving.current);
    saving.current = setTimeout(() => {
      void (text.trim() === ''
        ? Promise.resolve()
        : store.setDraft(conversationId, text, Date.now())
      );
    }, 400);
    return () => {
      if (saving.current !== null) clearTimeout(saving.current);
    };
  }, [text, loaded, conversationId, store]);

  /** The text, and the one setter that marks the draft as this member's own. */
  return [text, (value: string) => {
    touched.current = true;
    setText(value);
  }] as const;
}
export function Composer({
  permission,
  conversationId,
  send,
  store,
}: ComposerDeps) {
  const [text, setText] = useDraft(conversationId, store);
  const state = guard(permission, text);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stagedFiles, setStagedFiles] = useState<{ id: string; name: string; url: string }[]>([]);

  // ADR 0051's three belts. A flag we own, then the property, then the legacy
  // sniff — no one of them is sufficient, and the microtask on `compositionend`
  // is what survives Safari sending `keydown` after the composition ends.
  const composing = useRef(false);

  function commit() {
    if (state.kind !== 'ready') return;
    send(text);
    setText('');
    setStagedFiles([]);
  }

  function handlePickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    const added = files.map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      url: URL.createObjectURL(f),
    }));
    setStagedFiles((prev) => [...prev, ...added]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter') return;
    // Belt 1 — the flag we own.
    if (composing.current) return;
    // Belt 2 — the property, for any browser that reports it correctly.
    if (event.nativeEvent.isComposing) return;
    // Belt 3 — the "legacy sniff" the chat-view document rejected. It is what
    // Safari honours, and it is kept for exactly that reason.
    if (event.keyCode === 229) return;
    if (!event.shiftKey) {
      event.preventDefault();
      commit();
    }
  }

  const locked = state.kind === 'locked';
  const lockCopy = locked
    ? state.reason === 'blocked_by_me'
      ? 'You blocked this conversation.'
      : state.reason === 'blocked_by_them'
        ? 'You cannot send messages to this conversation.'
        : 'You cannot send messages here.'
    : null;

  return (
    <div className="shrink-0 bg-wash px-4 pb-4 pt-1">
      {lockCopy !== null && (
        <p role="status" className="mx-auto max-w-[760px] pb-1 text-[13px] text-danger">
          {lockCopy}
        </p>
      )}
      {stagedFiles.length > 0 && (
        <div className="mx-auto mb-2 flex max-w-[760px] gap-2 overflow-x-auto py-1">
          {stagedFiles.map((item) => (
            <div
              key={item.id}
              className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-card shadow-2xs ring-1 ring-hairline"
            >
              <img src={item.url} alt={item.name} className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => setStagedFiles((prev) => prev.filter((f) => f.id !== item.id))}
                aria-label={`Remove ${item.name}`}
                className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-[10px] text-white hover:bg-black/80"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mx-auto flex w-full max-w-[760px] items-end gap-1 rounded-2xl bg-card px-2 py-1.5 ring-1 ring-hairline">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handlePickFile}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Add photo"
          title="Attach image"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-press"
        >
          <ClipIcon />
        </button>
        <label htmlFor={`composer-${conversationId}`} className="sr-only">
          {`Message ${conversationId}`}
        </label>
        <textarea
          id={`composer-${conversationId}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            // The microtask is belt 1's payload: Safari's late `keydown` still
            // sees the flag as true.
            queueMicrotask(() => {
              composing.current = false;
            });
          }}
          placeholder="Message"
          rows={1}
          className="max-h-32 min-h-9 min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="button"
          aria-label="Emoji"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-press"
        >
          <SmileIcon />
        </button>
        <button
          type="button"
          onClick={commit}
          disabled={state.kind !== 'ready'}
          aria-label="Send message"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-white hover:brightness-95 disabled:opacity-40"
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );
}
