/**
 * The per-conversation read-receipt sharing toggle (ADR 0022, 0058, 0059).
 *
 * Transport, and why this is its own file: `receipt.sharing` is written by the
 * **settings** path (`POST /api/conversations/{id}/receipt/sharing`) — never
 * by a receipt advance, which is the separate transport. The flag is a signal
 * (0058), and its STORED value is read from the membership read. Both facts
 * are pinned here and nothing else is written through this control.
 *
 * The copy must not promise "invisible" (0058): there is no position leak, but
 * progress *rate* is observable, so a share-off period shows up as a pause and
 * then a slower-than-normal catch-up. This states what is actually true.
 */
import { useCallback, useEffect, useState } from 'react';

export interface SharingDeps {
  /** The conversation the flag belongs to. */
  readonly conversationId: string;
  /** Where the current flag comes from: the membership read. */
  readonly readSharing: (conversationId: string) => Promise<boolean>;
  /** The settings write. `true` means the advance moves `shared_through`. */
  readonly setSharing: (conversationId: string, sharing: boolean) => Promise<boolean>;
}

export function SharingToggle({ conversationId, readSharing, setSharing }: SharingDeps) {
  const [sharing, setStoredSharing] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readSharing(conversationId).then((next) => {
      if (!cancelled) setStoredSharing(next);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId, readSharing]);

  const toggle = useCallback(async () => {
    const previous = sharing;
    const next = !previous;
    setStoredSharing(next);
    setSaving(true);
    setFailed(false);
    try {
      const stored = await setSharing(conversationId, next);
      // The 200 echo IS the truth; a refusal leaves the flag where it was.
      setStoredSharing(stored);
    } catch {
      setStoredSharing(previous);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }, [conversationId, sharing, setSharing]);

  return (
    <section data-kind="privacy" className="rounded-2xl bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Read receipts</h2>
          <p className="mt-1 text-[13px] text-ink-faint">
            Off: you still read normally and your unread badge still works —
            they stop seeing how far you have read.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={sharing}
          aria-label="Read receipts"
          disabled={saving || failed}
          onClick={() => void toggle()}
          className={`mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${
            sharing ? 'bg-accent' : 'bg-ink-faint/40'
          } disabled:opacity-40`}
        >
          <span
            className={`block h-5 w-5 rounded-full bg-white shadow transition-transform ${
              sharing ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
      {failed && (
        <p role="status" className="mt-2 text-[13px] text-danger">
          The change could not be saved.
        </p>
      )}
    </section>
  );
}
