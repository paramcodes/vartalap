/**
 * The settings route. `/settings` is the global page; `/c/:id/settings` adds
 * the per-conversation sharing toggle. Sharing is a settings write, so both of
 * its ends are the membership read and the `/receipt/sharing` POST — the
 * receipt-advance transport is never touched here (ADR 0059).
 */
import { useParams } from 'react-router';
import { SettingsPage } from './settings.tsx';

/** Read the stored flag from the membership read — the one source of truth. */
async function readSharing(conversationId: string): Promise<boolean> {
  const response = await fetch(`/api/conversations/${conversationId}`, { credentials: 'include' });
  if (!response.ok) throw new Error('the membership read failed');
  const body = (await response.json()) as { sharing?: boolean };
  return body.sharing ?? true;
}

/** The settings write. The 200 echo carries the stored flag; that is the truth. */
async function setSharing(conversationId: string, sharing: boolean): Promise<boolean> {
  const response = await fetch(`/api/conversations/${conversationId}/receipt/sharing`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, sharing }),
  });
  if (!response.ok) throw new Error('the sharing write failed');
  const body = (await response.json()) as { sharing?: boolean };
  return body.sharing ?? sharing;
}

export function ConversationSettings() {
  const { id } = useParams<{ id: string }>();
  if (id === undefined) {
    return <SettingsPage />;
  }
  return <SettingsPage conversationId={id} sharing={{ readSharing, setSharing }} />;
}

/** The global page: theme and the facts, with nothing per-conversation. */
export function GlobalSettings() {
  return <SettingsPage />;
}
