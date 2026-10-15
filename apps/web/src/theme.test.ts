/**
 * 6.1 — the token layer, pinned rather than eyeballed (ADR 0002).
 *
 * Trap 1: a token with no caller does not exist. These tests assert the shell
 * spends the tokens it names AND that the built CSS still carries them — a
 * token Tailwind tree-shook out of the build is a comment, not a token.
 * Trap 2: `@theme inline` freezes every value at build time and leaves `.dark`
 * nothing to override, so the plain form is asserted byte-exactly.
 */
import { describe, expect, test } from 'bun:test';

const theme = await Bun.file(new URL('./theme.css', import.meta.url)).text();

describe('token layer', () => {
  test('plain @theme, never @theme inline', () => {
    expect(theme).toMatch(/^@theme \{/m);
    expect(theme).not.toMatch(/^@theme inline/m);
  });

  test('the radius anchor is exact — 12.86 silently breaks every radius', () => {
    expect(theme).toContain('--radius: 12.857px;');
    expect(theme).not.toMatch(/^  --radius: 12\.86[^7]/m);
  });

  test('.dark overrides surfaces and ink but never the outgoing bubble', () => {
    const dark = theme.slice(theme.indexOf('.dark {'));
    expect(dark).toContain('--color-wash:');
    expect(dark).toContain('--color-ink:');
    expect(dark).not.toContain('--color-accent:');
    expect(dark).not.toContain('--color-bubble-out:');
  });

  test('the built CSS carries the spent tokens and the .dark scope', async () => {
    const glob = new Bun.Glob('dist/assets/*.css');
    const files: string[] = [];
    for await (const path of glob.scan({ cwd: new URL('..', import.meta.url).pathname })) {
      files.push(path);
    }
    expect(files.length).toBeGreaterThan(0);
    const css = await Bun.file(
      new URL(`../${files.sort()[0]}`, import.meta.url),
    ).text();
    // Spent by the shell: bg-wash, text-ink, bg-accent, rounded-xl.
    expect(css).toContain('--color-wash');
    expect(css).toContain('--color-accent');
    expect(css).toContain('.dark');
  });
});
