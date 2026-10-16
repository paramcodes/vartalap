/**
 * Every prototype inlines ADR 0002's `@theme` block, because the Tailwind browser
 * build cannot `@import` it — see `prototype/README.md`. The duplication is forced,
 * so this script is what makes it safe: two prototypes that disagree about a token
 * are two prototypes that render differently, silently, with no error anywhere.
 *
 * The comparison is byte-for-byte, comments included. A reindented
 * `rgba(0,0,0,0.06)` counts as drift, because the block is meant to be copied, not
 * maintained five times by hand.
 *
 * It also catches the failure that actually shipped once already: a prototype using
 * `rounded-2xl` or `bg-surface` while its own `@theme` never declared the token, so
 * the class resolved to nothing. Syncing the block fixes that; `bun run check:tokens`
 * is what tells you it happened.
 *
 * Bun built-ins only. Run from the repo root: `bun run check:tokens`.
 */
import { Glob } from 'bun';
import { basename, join, relative } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const prototypeDir = join(repoRoot, 'prototype');

/** The style element whose contents Tailwind v4's browser build compiles. */
const styleElement = /<style\s+type="text\/tailwindcss"\s*>([\s\S]*?)<\/style>/;

/**
 * The text between `{` at `open` and its matching `}`, skipping comments so a brace
 * inside a comment cannot unbalance the scan. Returns null if the block never closes.
 */
function blockBody(css: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  return null;
}

/** Every `open`..`}` block in `css`, concatenated. More than one is still one unit. */
function allBlocks(css: string, opener: RegExp): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(opener)) {
    const open = match.index + match[0].length - 1;
    const body = blockBody(css, open);
    if (body !== null) found.push(body);
  }
  return found;
}

/**
 * Only the `@theme` style element counts. A `.dark` block in a plain `<style>` tag,
 * or in a sample string rendered into the page, is page content and must not be
 * mistaken for the token override it looks like.
 */
function tokensOf(html: string): { theme: string; dark: string } | null {
  const css = styleElement.exec(html)?.[1];
  if (css === undefined) return null;
  return {
    theme: allBlocks(css, /@theme\s*\{/g).join('\n'),
    dark: allBlocks(css, /\.dark\s*\{/g).join('\n'),
  };
}

/**
 * The app's canonical copy. `apps/web/src/theme.css` is raw CSS (no
 * `<style>` wrapper), so the blocks are extracted directly — and compared
 * against the same reference as the prototypes. A prototype that disagrees
 * with the app renders wrong with no error anywhere; an app theme that
 * disagrees with ADR 0002 is the same failure wearing a build step.
 *
 * Convergence decision (unit 6.1): the prototypes STAY inlined — the Tailwind
 * browser build cannot `@import`, so convergence onto one file is impossible
 * and this script is the convergence. The day a `packages/*` library carries
 * a class, its `@source` line belongs in `theme.css`, and a third block source
 * here would mean the duplication escaped.
 */
function tokensOfApp(css: string): { theme: string; dark: string } {
  return {
    theme: allBlocks(css, /@theme\s*\{/g).join('\n'),
    dark: allBlocks(css, /\.dark\s*\{/g).join('\n'),
  };
}

/** The line number where two texts part company, 1-based. */
function firstDivergence(a: string, b: string): number {
  const left = a.split('\n');
  const right = b.split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) return i + 1;
  }
  return 0;
}

const show = (line: string | undefined) => (line === undefined ? '<missing line>' : line.trim());

const glob = new Glob('prototype/**/*.html');
const paths: string[] = [];
for await (const path of glob.scan({ cwd: repoRoot })) paths.push(path);
paths.sort();

if (paths.length === 0) {
  console.error('✗ no HTML found under prototype/ — nothing to check');
  process.exit(1);
}

type TokenSet = { theme: string; dark: string };
const found = new Map<string, TokenSet | null>();
for (const path of paths) {
  found.set(path, tokensOf(await Bun.file(join(repoRoot, path)).text()));
}

console.log(`checking ${paths.length} file${paths.length === 1 ? '' : 's'}:`);
for (const path of paths) console.log(`  ${path}`);
console.log('');

let broken = false;

/** Reports every file whose `label` block differs from the first file that has one. */
function compare(label: string, pick: (t: TokenSet) => string) {
  const reference = paths.find((p) => found.get(p) !== null);
  const expected = reference === undefined ? '' : pick(found.get(reference)!);

  const drifted: string[] = [];
  for (const path of paths) {
    const tokens = found.get(path);
    if (tokens === null) {
      console.log(`✗ ${label}: ${path} has no <style type="text/tailwindcss"> element`);
      drifted.push(path);
      continue;
    }
    const actual = pick(tokens);
    if (actual === expected) continue;
    const line = firstDivergence(expected, actual);
    const a = expected.split('\n')[line - 1];
    const b = actual.split('\n')[line - 1];
    drifted.push(path);
    console.log(`✗ ${label} differs in ${relative(join(repoRoot, ''), path)} (first difference at line ${line})`);
    console.log(`    ${basename(reference!)}: ${show(a)}`);
    console.log(`    ${basename(path)}: ${show(b)}`);
  }

  if (drifted.length === 0) {
    console.log(`✓ ${label} in sync across ${paths.length} files`);
  } else {
    broken = true;
    console.log(`  ${drifted.length} of ${paths.length} files differ on ${label}\n`);
  }
}

compare('@theme block', (t) => t.theme);
compare('.dark overrides', (t) => t.dark);

// ── the app's copy ──────────────────────────────────────────────────────────
// Same reference, same byte-for-byte rule (comments included). `theme.css`
// carries the file's own header comment outside the blocks, which is why only
// the extracted blocks participate — the header is allowed to say where the
// file lives, the blocks are not allowed to disagree about a value.
{
  const appCss = await Bun.file(join(repoRoot, 'apps/web/src/theme.css')).text();
  const app = tokensOfApp(appCss);
  const reference = paths.find((p) => found.get(p) !== null);
  const expected: TokenSet = reference === undefined ? { theme: '', dark: '' } : found.get(reference)!;
  let appBroken = false;
  for (const [label, pick] of [
    ['@theme block', (t: TokenSet) => t.theme],
    ['.dark overrides', (t: TokenSet) => t.dark],
  ] as const) {
    if (pick(app) !== pick(expected)) {
      const line = firstDivergence(pick(expected), pick(app));
      console.log(`✗ app ${label} differs in apps/web/src/theme.css (first difference at line ${line})`);
      appBroken = true;
    }
  }
  if (!appBroken) {
    console.log('✓ app theme.css in sync with the prototypes');
  } else {
    broken = true;
  }
}

if (broken) {
  console.error(
    'Token blocks have drifted. Copy the block from prototype/messenger-shell/index.html\n' +
      'verbatim — do not hand-merge, and do not change a value. The values are ADR 0002.',
  );
  process.exit(1);
}

console.log(`\n✓ all ${paths.length} in sync`);
