/**
 * Gate S3 — media pipeline (ADR 0008 & ADR 0052).
 *
 * Proves:
 * - Server-side byte sniff accepts only image allowlist (JPEG, PNG, WebP, GIF).
 * - Executables, HTML scripts, and PDFs are rejected.
 * - Raw upload is NEVER served (ADR 0008).
 * - Only derived variants (thumb, preview, full) can be retrieved.
 */
import { describe, expect, test } from 'bun:test';
import {
  getDerivedBytes,
  sniffImageMime,
  storeDerivedBytes,
} from './media.ts';

describe('Gate S3: server-side byte sniffing allowlist (ADR 0008)', () => {
  test('JPEG magic numbers are accepted', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    expect(sniffImageMime(bytes)).toBe('image/jpeg');
  });

  test('PNG magic numbers are accepted', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    expect(sniffImageMime(bytes)).toBe('image/png');
  });

  test('GIF magic numbers are accepted', () => {
    const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00]);
    expect(sniffImageMime(bytes)).toBe('image/gif');
  });

  test('WebP magic numbers are accepted', () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x24, 0x00, 0x00, 0x00, // size
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    expect(sniffImageMime(bytes)).toBe('image/webp');
  });

  test('HTML, JavaScript, and shell scripts are rejected', () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html><script>alert(1)</script>');
    expect(sniffImageMime(html)).toBeNull();

    const js = new TextEncoder().encode('console.log("hello world");');
    expect(sniffImageMime(js)).toBeNull();

    const bash = new TextEncoder().encode('#!/bin/bash\necho dangerous');
    expect(sniffImageMime(bash)).toBeNull();
  });

  test('short or arbitrary binary files are rejected', () => {
    expect(sniffImageMime(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    const pdf = new TextEncoder().encode('%PDF-1.4\n%...');
    expect(sniffImageMime(pdf)).toBeNull();
  });
});

describe('Gate S3: raw upload is never served (ADR 0008)', () => {
  test('requesting the raw variant is refused unconditionally', () => {
    const mediaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    storeDerivedBytes(mediaId, 'thumb', new Uint8Array([1, 2, 3]), 'image/webp');

    // Attempt to access raw upload must return null (404/refusal)
    expect(getDerivedBytes(mediaId, 'raw')).toBeNull();
  });

  test('only derived variants (thumb, preview, full) are retrievable', () => {
    const mediaId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const thumbBytes = new Uint8Array([1, 2, 3, 4]);
    const previewBytes = new Uint8Array([5, 6, 7, 8]);
    const fullBytes = new Uint8Array([9, 10, 11, 12]);

    storeDerivedBytes(mediaId, 'thumb', thumbBytes, 'image/webp');
    storeDerivedBytes(mediaId, 'preview', previewBytes, 'image/webp');
    storeDerivedBytes(mediaId, 'full', fullBytes, 'image/webp');

    expect(getDerivedBytes(mediaId, 'thumb')?.bytes).toEqual(thumbBytes);
    expect(getDerivedBytes(mediaId, 'preview')?.bytes).toEqual(previewBytes);
    expect(getDerivedBytes(mediaId, 'full')?.bytes).toEqual(fullBytes);

    // Any invalid/unknown variant is refused
    expect(getDerivedBytes(mediaId, 'original')).toBeNull();
    expect(getDerivedBytes(mediaId, 'download')).toBeNull();
  });
});
