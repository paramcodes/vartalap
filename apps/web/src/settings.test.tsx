/**
 * T4 in part 3: the three forbidden switches are asserted ABSENT as controls and
 * present as sentences — not assumed. ADR 0022's rule: a disabled toggle reads
 * as a promise this build has not kept yet, so a declined decision is written
 * as a fact. If someone ships one, this test fails.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { FORBIDDEN_SWITCHES, SettingsPage } from './settings.tsx';

// `screen` is one document for the whole run; without this, a render left by an
// earlier file answers the next file's queries.
afterEach(() => cleanup());

const CONVERSATION = '77777777-7777-4777-8777-777777777777';

describe('the settings page', () => {
  test('renders the theme control and says it is on this device', () => {
    render(<SettingsPage />);
    expect(screen.getByText(/on this device/i)).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Light' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'System' })).toBeDefined();
  });

  test('renders the sharing toggle only on the per-conversation page', () => {
    const { unmount } = render(<SettingsPage />);
    expect(screen.queryByRole('switch', { name: 'Read receipts' })).toBeNull();
    unmount();
    render(
      <SettingsPage
        conversationId={CONVERSATION}
        sharing={{
          readSharing: async () => true,
          setSharing: async () => true,
        }}
      />,
    );
    expect(screen.getByRole('switch', { name: 'Read receipts' })).toBeDefined();
  });

  test('the three forbidden switches are sentences, never controls', () => {
    render(
      <SettingsPage
        conversationId={CONVERSATION}
        sharing={{
          readSharing: async () => true,
          setSharing: async () => true,
        }}
      />,
    );
    // None of them is a switch, a checkbox, or a button.
    expect(screen.queryByRole('switch')).toBeDefined(); // the sharing one IS a switch
    const forbiddenAsControls = FORBIDDEN_SWITCHES.flatMap((one) => [
      screen.queryByRole('switch', { name: new RegExp(one.key, 'i') }),
      screen.queryByRole('checkbox', { name: new RegExp(one.key, 'i') }),
    ]);
    expect(forbiddenAsControls.every((node) => node === null)).toBe(true);
    // Each one is present as a sentence.
    for (const one of FORBIDDEN_SWITCHES) {
      expect(screen.getByText(one.sentence)).toBeDefined();
    }
  });

  test('the copy does not promise invisibility', () => {
    render(
      <SettingsPage
        conversationId={CONVERSATION}
        sharing={{
          readSharing: async () => true,
          setSharing: async () => true,
        }}
      />,
    );
    const section = screen.getByText('Read receipts').closest('section')!;
    expect(section.textContent).not.toMatch(/invisible/i);
  });
});
