/**
 * Column 4 per ADR 0055: The conversation details pane (300px).
 *
 * Refused below 1150px (ADR 0055: "losing the room for a pane is not the
 * same as deciding to close it"). Shows conversation peer avatar, actions,
 * and shared media placeholder.
 */
import { initialsOf, hueOf } from './list.ts';

const MEDIA_TILES = [
  'linear-gradient(135deg,#a1c4fd,#c4a1fd)',
  'linear-gradient(135deg,#fdbf80,#fc8f8f)',
  'linear-gradient(135deg,#84fab0,#8fd3f4)',
  'linear-gradient(135deg,#fddb92,#f1a9f5)',
  'linear-gradient(135deg,#a18cd1,#fbc2eb)',
  'linear-gradient(135deg,#f6d365,#fda085)',
];

export interface DetailsPaneProps {
  readonly title: string;
  readonly conversationId: string;
  readonly isOnline?: boolean;
}

export function DetailsPane({ title, conversationId, isOnline = true }: DetailsPaneProps) {
  const hue = hueOf(conversationId);
  const initials = initialsOf(title);

  return (
    <aside
      aria-label="Conversation details"
      className="hidden xl:flex w-[300px] shrink-0 flex-col overflow-y-auto border-s border-hairline bg-card"
    >
      <div className="flex flex-col items-center gap-1.5 px-4 pb-3 pt-5 text-center">
        <span
          aria-hidden="true"
          className="flex h-20 w-20 items-center justify-center rounded-full text-2xl font-bold text-white shadow-xs"
          style={{ background: `hsl(${hue} 46% 46%)` }}
        >
          {initials}
        </span>
        <div className="text-[17px] font-bold tracking-tight text-ink">{title}</div>
        <div className="text-[13px] text-[#31a24c]">{isOnline ? 'Active now' : 'Offline'}</div>

        <div className="mt-3 grid w-full grid-cols-3 gap-2">
          {['Profile', 'Mute', 'Search'].map((action) => (
            <button
              key={action}
              type="button"
              className="rounded-lg py-2 text-[12px] font-semibold text-accent transition-colors hover:bg-press"
            >
              {action}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="mb-2 text-[15px] font-bold tracking-tight text-ink">Media, Files and Links</div>
        <div className="mb-3 flex gap-4 border-b border-hairline text-[13px] font-medium">
          {['Media', 'Files', 'Links'].map((tab, idx) => (
            <button
              key={tab}
              type="button"
              className={`-mb-px border-b-2 pb-2 ${
                idx === 0 ? 'border-accent text-ink font-semibold' : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {MEDIA_TILES.map((bg, idx) => (
            <div key={idx} className="aspect-square rounded-md shadow-2xs" style={{ background: bg }} />
          ))}
        </div>
      </div>

      <div className="mx-4 mb-4 rounded-lg border border-dashed border-ink-faint/50 p-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[13px] font-semibold text-ink">Shared group</span>
          <span className="rounded bg-press px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-muted">
            v2
          </span>
        </div>
        <p className="text-[11px] leading-snug text-ink-faint">
          Favourite chats. Membership-scoped — expires when you leave.
        </p>
      </div>

      <div className="mt-auto border-t border-hairline px-4 py-3">
        <button type="button" className="text-[13px] font-medium text-ink-muted hover:text-ink">
          Privacy and Support
        </button>
      </div>
    </aside>
  );
}
