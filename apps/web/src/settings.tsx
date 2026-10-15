/**
 * The settings page — unit 6.5, gate T4.
 *
 * Two homes and two transports, and the third setting is neither. The page
 * renders only the two settings whose homes and transports exist in the
 * committed spine: theme (device-local) and read-receipt sharing (membership,
 * written by the settings POST). Per-conversation mute rides the membership read
 * but its write transport is not in stage 5, and the account-scoped profile
 * edits (`display name`, `avatar`, `casing`) have no transport either — both are
 * flagged in `docs/adr/0063` as stage-5 gaps, not quietly half-wired here.
 *
 * The three forbidden switches are the other half of the gate, and they are
 * rendered as sentences rather than disabled toggles — ADR 0022's rule that a
 * greyed control reads as a promise this build has not kept yet.
 */
import { ThemeToggle } from './theme-toggle.tsx';
import { SharingToggle } from './sharing-toggle.tsx';
import type { SharingDeps } from './sharing-toggle.tsx';

/**
 * The three switches that must not exist, and the sentence each one earns.
 * A test fails if any of them ever arrives as a control.
 */
export const FORBIDDEN_SWITCHES = [
  {
    key: 'lastSeen',
    sentence: 'vartalap never records when you were last online.',
  },
  {
    key: 'hideActiveStatus',
    sentence: 'Presence is a fact about your connection, not a setting.',
  },
  {
    key: 'profileVisibility',
    sentence: 'Every signed-up member can see your profile. vartalap is an open directory.',
  },
] as const;

export interface SettingsDeps {
  /** Present on the per-conversation settings page; the sharing toggle only then. */
  readonly conversationId?: string;
  readonly sharing?: Pick<SharingDeps, 'readSharing' | 'setSharing'>;
}

export function SettingsPage({ conversationId, sharing }: SettingsDeps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full max-w-xl flex-col gap-3 p-3">
        <ThemeToggle />
        {conversationId !== undefined && sharing !== undefined && (
          <SharingToggle
            conversationId={conversationId}
            readSharing={sharing.readSharing}
            setSharing={sharing.setSharing}
          />
        )}
        <section data-kind="offered-as-facts" className="rounded-2xl bg-card p-3">
          <h2 className="text-[15px] font-semibold text-ink">Things vartalap does not offer</h2>
          <p className="mt-1 text-[13px] text-ink-faint">
            These are facts about vartalap, not switches waiting to be built.
          </p>
          <ul className="mt-2 list-disc space-y-1 ps-5 text-[13px] text-ink-muted">
            {FORBIDDEN_SWITCHES.map((one) => (
              <li key={one.key}>{one.sentence}</li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
