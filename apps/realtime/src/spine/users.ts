/**
 * Handles in, user rows out. One place, because every route that names a
 * person by handle must normalise and resolve the same way — and a second
 * lookup that forgot to lowercase would invent a second identity for one
 * member.
 *
 * Handles are lowercase by construction (the `username()` plugin normalises on
 * write, and the `user_username_lower_key` index catches writers that bypass
 * it), so lookup is exact against the stored form. An unknown handle is `null`,
 * never an throw: naming somebody who does not exist is a normal request, and
 * the route decides the status.
 */
import { inArray } from 'drizzle-orm';
import { db, user } from '@vartalap/database';
import { eq } from 'drizzle-orm';
import { normalizeHandle } from '@vartalap/protocol';

export interface ResolvedUser {
  readonly id: string;
  readonly username: string;
  readonly name: string;
}

/** One handle. `null` when nobody holds it. */
export async function lookupUserId(handle: string): Promise<string | null> {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, normalizeHandle(handle)))
    .limit(1);
  return row?.id ?? null;
}

/** Many handles, one query. Unknown handles come back as `missing`, named. */
export async function resolveUsers(handles: readonly string[]): Promise<{
  readonly resolved: ResolvedUser[];
  readonly missing: string | null;
}> {
  const normalized = [...new Set(handles.map(normalizeHandle))];
  if (normalized.length === 0) return { resolved: [], missing: null };
  const rows = await db
    .select({ id: user.id, username: user.username, name: user.name })
    .from(user)
    .where(inArray(user.username, normalized));
  const byUsername = new Map(rows.map((row) => [row.username, row]));
  for (const handle of normalized) {
    if (!byUsername.has(handle)) return { resolved: [], missing: handle };
  }
  return {
    resolved: normalized.map((handle) => {
      const row = byUsername.get(handle)!;
      return { id: row.id, username: row.username, name: row.name };
    }),
    missing: null,
  };
}
