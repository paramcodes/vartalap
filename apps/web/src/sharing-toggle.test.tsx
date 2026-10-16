/**
 * T4 in part 2: the sharing toggle rides the settings transport, never the
 * receipt advance (ADR 0059). The flag is read from the membership read and
 * written by `/receipt/sharing`; the advance transport is not a field here.
 *
 * The server's 200 echo is the stored truth (0058): the toggle renders what the
 * server says, not what the click hoped. A refusal leaves the flag where it was.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SharingToggle } from './sharing-toggle.tsx';

// `screen` is one document for the whole run; without this, a render left by an
// earlier file answers the next file's queries.
afterEach(() => cleanup());

const CONVERSATION = '66666666-6666-4666-8666-666666666666';

describe('the sharing toggle rides the settings transport', () => {
  test('reads the stored flag from the membership read, not from a position', async () => {
    const readSharing = async () => true;
    const setSharing = async () => true;
    render(<SharingToggle conversationId={CONVERSATION} readSharing={readSharing} setSharing={setSharing} />);
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Read receipts' })!.getAttribute('aria-checked')).toBe('true'),
    );
  });

  test('a stored false renders off', async () => {
    render(
      <SharingToggle
        conversationId={CONVERSATION}
        readSharing={async () => false}
        setSharing={async () => false}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Read receipts' })!.getAttribute('aria-checked')).toBe('false'),
    );
  });

  test('toggling writes the settings transport with the opposite flag', async () => {
    const writes: boolean[] = [];
    render(
      <SharingToggle
        conversationId={CONVERSATION}
        readSharing={async () => true}
        setSharing={async (_id, sharing) => {
          writes.push(sharing);
          return sharing;
        }}
      />,
    );
    const toggle = await screen.findByRole('switch', { name: 'Read receipts' });
    fireEvent.click(toggle);
    await waitFor(() => expect(writes).toEqual([false]));
  });

  test('the 200 echo is the truth — a stored opposite wins over the click', async () => {
    // The click hoped `true`; the server stored `false`. Render the stored.
    render(
      <SharingToggle
        conversationId={CONVERSATION}
        readSharing={async () => false}
        setSharing={async () => false}
      />,
    );
    const toggle = await screen.findByRole('switch', { name: 'Read receipts' });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Read receipts' })!.getAttribute('aria-checked')).toBe('false'),
    );
  });

  test('a refusal leaves the flag where it was and says so', async () => {
    render(
      <SharingToggle
        conversationId={CONVERSATION}
        readSharing={async () => true}
        setSharing={async () => {
          throw new Error('nope');
        }}
      />,
    );
    const toggle = await screen.findByRole('switch', { name: 'Read receipts' });
    fireEvent.click(toggle);
    await screen.findByText('The change could not be saved.');
    expect(screen.getByRole('switch', { name: 'Read receipts' })!.getAttribute('aria-checked')).toBe('true');
  });
});
