/**
 * The theme — device-local (ADR 0022), never account-scoped.
 *
 * "Anything needed before first paint is device-local." Theme is the ur-example:
 * reading `user_settings` before first paint would trade a blocking round trip
 * on every load for a preference that is inherently about this screen.
 *
 * What lives here:
 *   - `read`/`write`/`apply`: the device-local round trip.
 *   - System is the *absence* of a stored key (ADR 0022), never a stored value,
 *     so following the OS later needs no write — only a `matchMedia` listener.
 *
 * Scope rule (0002): tokens still come from `theme.css`; this file owns the
 * mechanism around them and is the only caller of `localStorage` for the theme.
 */
export const THEME_KEY = 'vartalap.theme';
export const SYSTEM_MQ = '(prefers-color-scheme: dark)';

export type Theme = 'light' | 'dark' | 'system';

export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

export function readTheme(storage: Storage = globalThis.localStorage): Theme {
  const stored = storage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return 'system';
}

export function writeTheme(theme: Theme, storage: Storage = globalThis.localStorage): void {
  if (theme === 'light' || theme === 'dark') {
    storage.setItem(THEME_KEY, theme);
  } else {
    storage.removeItem(THEME_KEY);
  }
}

export function prefersDark(matchMediaFn: (query: string) => MediaQueryList = (q) =>
  window.matchMedia(q),
): boolean {
  try {
    return matchMediaFn(SYSTEM_MQ).matches;
  } catch {
    return false;
  }
}

export function resolvesDark(theme: Theme, mediaDark: boolean): boolean {
  if (theme === 'light') return false;
  if (theme === 'dark') return true;
  return mediaDark;
}

export function applyTheme(
  theme: Theme,
  opts: { storage?: Storage; doc?: Document; matchMediaFn?: (query: string) => MediaQueryList } = {},
): void {
  const storage = opts.storage ?? globalThis.localStorage;
  const doc = opts.doc ?? globalThis.document;
  const matchMediaFn = opts.matchMediaFn ?? ((q) => window.matchMedia(q));
  const root = doc.documentElement;
  const dark = resolvesDark(theme, prefersDark(matchMediaFn));
  root.classList.toggle('dark', dark);
  // Commit the value too, so a caller that re-reads gets the merged truth.
  writeTheme(theme, storage);
}

/**
 * The system-mode side channel: when `theme === 'system'`, the `<html>` class
 * has to follow the OS *without* a write (ADR 0022). One listener, off when
 * any explicit value is stored, so a device that picked light or dark stops
 * fluttering when the OS flips.
 */
export function attachSystemListener(
  getTheme: () => Theme,
  opts: { doc?: Document; matchMediaFn?: (query: string) => MediaQueryList } = {},
): () => void {
  const doc = opts.doc ?? globalThis.document;
  const matchMediaFn = opts.matchMediaFn ?? ((q) => window.matchMedia(q));
  const mq = matchMediaFn(SYSTEM_MQ);
  const handler = () => {
    if (getTheme() !== 'system') return;
    doc.documentElement.classList.toggle('dark', mq.matches);
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
