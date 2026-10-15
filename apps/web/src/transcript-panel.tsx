/**
 * The transcript route panel: the route's id, the header 6.3 owes it, and the
 * transcript itself. Kept separate from `transcript.tsx` so the component stays
 * injectable in tests and the route owns nothing but the id.
 */
import { useParams } from 'react-router';
import { useAppDeps } from './layout.tsx';
import { Transcript } from './transcript.tsx';

/** `/` — the transcript pane with nothing selected. */
export function EmptyTranscript() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2">
      <p className="text-ink-muted">Select a conversation.</p>
    </main>
  );
}

/** `/c/:id` — the transcript for one conversation. */
export function TranscriptPanel() {
  const { id } = useParams<{ id: string }>();
  const { viewerId } = useAppDeps();
  if (id === undefined) return <EmptyTranscript />;
  return <Transcript conversationId={id} viewerId={viewerId} />;
}
