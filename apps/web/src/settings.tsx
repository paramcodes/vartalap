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
import { useEffect, useState } from 'react';
import { ThemeToggle } from './theme-toggle.tsx';
import { SharingToggle } from './sharing-toggle.tsx';
import type { SharingDeps } from './sharing-toggle.tsx';

/** The signed-in member's own profile fields. */
export interface Profile {
  readonly handle: string | null;
  readonly displayName: string | null;
}

/**
 * The production read. Injected so a test never opens a socket.
 */
async function fetchProfile(): Promise<Profile | null> {
  const response = await fetch('/api/me', { credentials: 'include' });
  if (!response.ok) return null;
  return (await response.json()) as Profile;
}

export interface ProfileSectionDeps {
  readonly readProfile?: (() => Promise<Profile | null>) | undefined;
}

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

/**
 * The profile section — renders what cannot be edited, and says so (ADR 0021).
 * The handle is set at signup and never changes; it is shown as read-only text,
 * never as a disabled input (a disabled control reads as a promise unkept).
 */
export function ProfileSection({ readProfile = fetchProfile }: ProfileSectionDeps = {}) {
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readProfile().then((next) => {
      if (!cancelled) setProfile(next);
    });
    return () => {
      cancelled = true;
    };
  }, [readProfile]);

  return (
    <section data-kind="profile" className="rounded-2xl bg-card p-3">
      <h2 className="text-[15px] font-semibold text-ink">Profile</h2>
      <dl className="mt-2 space-y-2">
        <div>
          <dt className="text-[13px] text-ink-faint">Handle</dt>
          <dd className="text-[15px] text-ink">{profile?.handle ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-ink-faint">Display name</dt>
          <dd className="text-[15px] text-ink">{profile?.displayName ?? '—'}</dd>
        </div>
      </dl>
      <p className="mt-2 text-[13px] text-ink-faint">
        Your handle was set when you signed up and does not change.
      </p>
    </section>
  );
}

export interface SettingsDeps {
  /** Present on the per-conversation settings page; the sharing toggle only then. */
  readonly conversationId?: string;
  readonly sharing?: Pick<SharingDeps, 'readSharing' | 'setSharing'>;
  /** Injected in tests; production reads `/api/me`. */
  readonly readProfile?: () => Promise<Profile | null>;
}

export function SettingsPage({ conversationId, sharing, readProfile }: SettingsDeps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full max-w-xl flex-col gap-3 p-3">
        <ProfileSection readProfile={readProfile} />
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
