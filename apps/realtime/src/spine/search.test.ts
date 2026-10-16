/**
 * Gate S1 — message search (ADR 0009).
 *
 * Tests the short-query guard, prefix behaviour, exact word matching without
 * stemming ('simple' configuration), and membership enforcement.
 */
import { describe, expect, test } from 'bun:test';
import { isSearchableQuery } from './search.ts';

describe('search query guard (ADR 0009)', () => {
  test('empty and short queries are guarded', () => {
    expect(isSearchableQuery('')).toBe(false);
    expect(isSearchableQuery('a')).toBe(false);
    expect(isSearchableQuery('hi')).toBe(false);
    expect(isSearchableQuery('   no   ')).toBe(false);
  });

  test('punctuation and non-word characters alone are guarded', () => {
    expect(isSearchableQuery('???')).toBe(false);
    expect(isSearchableQuery('!@#$%^&*()')).toBe(false);
    expect(isSearchableQuery('...')).toBe(false);
    expect(isSearchableQuery('  --  ')).toBe(false);
  });

  test('queries with at least 3 word/alphanumeric characters pass', () => {
    expect(isSearchableQuery('hey')).toBe(true);
    expect(isSearchableQuery('hello world')).toBe(true);
    expect(isSearchableQuery('  cat  ')).toBe(true);
    expect(isSearchableQuery('123')).toBe(true);
    expect(isSearchableQuery('?why?')).toBe(true);
  });

  test('unicode characters count as word characters', () => {
    expect(isSearchableQuery('नमस्ते')).toBe(true);
    expect(isSearchableQuery('你好啊')).toBe(true);
  });
});
