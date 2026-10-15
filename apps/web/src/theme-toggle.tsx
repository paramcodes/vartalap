/**
 * The theme control — appears in settings and in the layout (ADR 0022).
 *
 * ADR 0049's discipline applied twice over: this reads and writes the device,
 * never the account, and the copy says "On this device" because it is true.
 */
import { useEffect, useState } from 'react';
import { THEMES, applyTheme, attachSystemListener, readTheme, writeTheme, type Theme } from './theme.ts';

const LABELS: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  useEffect(() => {
    applyTheme(theme, { storage: window.localStorage, doc: document, matchMediaFn: (q) => window.matchMedia(q) });
    const detach = attachSystemListener(() => theme, {
      doc: document,
      matchMediaFn: (q) => window.matchMedia(q),
    });
    return detach;
  }, [theme]);

  function choose(next: Theme) {
    writeTheme(next, window.localStorage);
    setTheme(next);
  }

  return (
    <section data-kind="appearance" className="rounded-2xl bg-card p-3">
      <h2 className="text-[15px] font-semibold text-ink">Appearance</h2>
      <p className="mt-1 text-[13px] text-ink-faint">
        On this device. Other devices keep their own look.
      </p>
      <div role="radiogroup" aria-label="Theme" className="mt-3 flex flex-wrap gap-2">
        {THEMES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={theme === option}
            onClick={() => choose(option)}
            className={`rounded-full px-3 py-1 text-[13px] ${
              theme === option ? 'bg-accent text-ink-on-accent' : 'bg-surface text-ink'
            }`}
          >
            {LABELS[option]}
          </button>
        ))}
      </div>
    </section>
  );
}