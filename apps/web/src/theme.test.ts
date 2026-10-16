/**
 * T4 in part 1: the theme is device-local. A second device does not inherit it
 * (ADR 0022), the round trip writes the right key, and `system` follows the OS
 * *without* a stored value — so flipping the OS later needs no write.
 *
 * No network, no account: these tests run entirely against the happy-dom
 * storage and document, which is the point.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  THEME_KEY,
  applyTheme,
  attachSystemListener,
  prefersDark,
  readTheme,
  resolvesDark,
  writeTheme,
} from './theme.ts';

// `screen` is one document for the whole run; without this, a render left by an
// earlier file answers the next file's queries.
afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('the theme home is the device', () => {
  test('with no stored value the theme is system', () => {
    expect(readTheme()).toBe('system');
  });

  test('light and dark round-trip through the key', () => {
    writeTheme('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(readTheme()).toBe('light');
    writeTheme('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(readTheme()).toBe('dark');
  });

  test('system is the absence of a key, not a stored value', () => {
    writeTheme('system');
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(readTheme()).toBe('system');
  });

  test('an unknown value falls back to system', () => {
    localStorage.setItem(THEME_KEY, 'halloween');
    expect(readTheme()).toBe('system');
  });
});

describe('resolving the class', () => {
  const apply = (theme: 'light' | 'dark' | 'system', mediaDark: boolean) => {
    const doc = document.implementation.createHTMLDocument();
    const storage = new Map<string, string>();
    const fakeStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    } as unknown as Storage;
    const matchMediaFn = () =>
      ({ matches: mediaDark, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList;
    applyTheme(theme, { storage: fakeStorage, doc, matchMediaFn });
    return { doc, storage };
  };

  test('light and dark set the class regardless of the OS', () => {
    expect(apply('light', true).doc.documentElement.classList.contains('dark')).toBe(false);
    expect(apply('dark', false).doc.documentElement.classList.contains('dark')).toBe(true);
  });

  test('system follows the OS without storing a value', () => {
    const dark = apply('system', true);
    expect(dark.doc.documentElement.classList.contains('dark')).toBe(true);
    expect(dark.storage.get(THEME_KEY)).toBeUndefined();
    const light = apply('system', false);
    expect(light.doc.documentElement.classList.contains('dark')).toBe(false);
    expect(light.storage.get(THEME_KEY)).toBeUndefined();
  });
});

describe('the system listener', () => {
  function harness(theme: () => 'system' | 'light' | 'dark', initial: boolean) {
    const doc = document.implementation.createHTMLDocument();
    const storage = new Map<string, string>();
    const fakeStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    } as unknown as Storage;
    const handlers = new Map<string, () => void>();
    const mq: { matches: boolean; addEventListener: (t: string, h: () => void) => void; removeEventListener: (t: string) => void } = {
      matches: initial,
      addEventListener: (type, handler) => void handlers.set(type, handler),
      removeEventListener: (type) => void handlers.delete(type),
    };
    const matchMediaFn = () => mq as unknown as MediaQueryList;
    const detach = attachSystemListener(theme, { doc, matchMediaFn });
    return { doc, mq, handlers, storage, detach, fakeStorage };
  }

  test('follows the OS while in system mode, and stops once a value is stored', () => {
    // System + OS flips to dark: the class follows, and nothing is stored.
    let theme: 'system' | 'light' = 'system';
    const h = harness(() => theme, false);
    h.mq.matches = true;
    h.handlers.get('change')!();
    expect(h.doc.documentElement.classList.contains('dark')).toBe(true);
    expect(h.storage.get(THEME_KEY)).toBeUndefined();

    // Now an explicit value: the listener no longer responds to OS changes.
    // (In the real component, applyTheme handles the class change when the
    // user picks a value; the listener only fires on passive OS changes.)
    theme = 'light';
    h.mq.matches = false;
    h.handlers.get('change')!();
    // The class stays as the OS change left it — the listener is inert.
    expect(h.doc.documentElement.classList.contains('dark')).toBe(true);
    h.detach();
  });

  test('detaching removes the listener', () => {
    const h = harness(() => 'system', false);
    h.detach();
    expect(h.handlers.has('change')).toBe(false);
  });

  test('resolvesDark and prefersDark agree on the corners', () => {
    expect(resolvesDark('system', true)).toBe(true);
    expect(resolvesDark('system', false)).toBe(false);
    expect(resolvesDark('light', true)).toBe(false);
    expect(resolvesDark('dark', false)).toBe(true);
    expect(prefersDark(() => ({ matches: true } as unknown as MediaQueryList))).toBe(true);
    expect(prefersDark(() => ({ matches: false } as unknown as MediaQueryList))).toBe(false);
  });
});
