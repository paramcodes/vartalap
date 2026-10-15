/**
 * The conversation list's pure rules (unit 6.2, gate T1).
 *
 * Ordering lives on the server (`ORDER BY last_seq DESC`, proved in
 * `list.test.ts`) — the client renders the array order it receives and never
 * re-sorts, because a second sort is a second opinion about the same question.
 * Everything here is presentation of an item, and every function is total:
 * a missing preview, a missing peer and a zero count all have decided pixels.
 */
import type { ConversationListItem } from '@vartalap/protocol';
import type { MessageRow } from './store.ts';

/** What the row's preview band says, and which styling it earns. */
export type Preview =
  | { readonly kind: 'locked'; readonly text: string }
  | { readonly kind: 'queued'; readonly text: string }
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'empty'; readonly text: string };

/** A direct title derives from the pair the key fixed — never stored (0007). */
export function deriveTitle(item: ConversationListItem, viewerId: string): string {
  if (item.kind === 'group') return item.title ?? 'Untitled group';
  const peer = item.peers?.find((candidate) => String(candidate.userId) !== viewerId);
  return peer?.displayName ?? 'Unknown';
}

/**
 * The preview is the newest queued send if the conversation has one, and
 * otherwise the newest message (0045) — both read off rows this browser holds.
 * Unpositioned rows sort above positioned ones by construction: a `seq` is a
 * server position and a client clock is not, so they never compare.
 */
export function pickPreview(rows: readonly MessageRow[]): Preview {
  const unpositioned = rows
    .filter((row) => row.seq === null)
    .sort((a, b) => b.createdAt - a.createdAt);
  const newest = unpositioned[0];
  if (newest !== undefined) return { kind: 'queued', text: newest.body };

  let best: MessageRow | undefined;
  for (const row of rows) {
    if (row.seq === null) continue;
    if (best === undefined || BigInt(row.seq) > BigInt(best.seq!)) best = row;
  }
  if (best !== undefined) return { kind: 'message', text: best.body };
  return { kind: 'empty', text: 'No messages yet' };
}

/** A blocked pair previews as a sentence, never as a message (concept). */
export function rowPreview(item: ConversationListItem, rows: readonly MessageRow[]): Preview {
  if (item.permission.allowed === false && item.permission.reason === 'blocked_by_me') {
    return { kind: 'locked', text: 'You blocked this conversation.' };
  }
  return pickPreview(rows);
}

/** Hidden at zero, capped at `99+` — the cap hides magnitude, never the fact. */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

export function badgeLabel(count: number): string {
  return `${count} unread message${count === 1 ? '' : 's'}`;
}

/**
 * The rounding rule from the concept, through `Intl` and nothing else.
 * Under an hour reads as nothing — the row is 72px tall and "Today" costs
 * eleven characters to say what the absence already implies.
 */
export function formatTime(atMs: number, nowMs: number): string | null {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  if (Number.isNaN(at.getTime())) return null;
  if (nowMs - atMs < 3_600_000 && nowMs >= atMs) return null;

  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (day(at) === day(now)) {
    return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(at);
  }
  const yesterday = new Date(nowMs - 86_400_000);
  if (day(at) === day(yesterday)) return 'Yesterday';
  if (nowMs - atMs < 7 * 86_400_000 && nowMs >= atMs) {
    return new Intl.DateTimeFormat('en', { weekday: 'long' }).format(at);
  }
  if (at.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(at);
  }
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(at);
}

/** Initials on a hue derived from the id — no avatar prompt at onboarding. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return '?';
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase();
}

export function hueOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % 360;
}
