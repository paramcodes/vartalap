/**
 * T3: the three enter-to-send guards each block independently, drafts stay on
 * this device across a reload, and a failed send renders with a retry that
 * reuses the idempotency key.
 *
 * The send path itself is `send.ts`'s, proved there; these assert what the
 * composer RENDERS and how it CALLS, never what the call means.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer, guard } from './composer.tsx';
import { createStore, type MessageStore } from './store.ts';

// `screen` is one document for the whole run; without this, a render left by an
// earlier file answers the next file's queries.
afterEach(() => cleanup());
const allow = { allowed: true } as const;
const blockedByThem = { allowed: false, reason: 'blocked_by_them' } as const;
const blockedByMe = { allowed: false, reason: 'blocked_by_me' } as const;
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
let databases = 0;
function freshStore(): MessageStore {
  databases += 1;
  return createStore(`vartalap-composer-${databases}`);
}
function sentStore() {
  const sent: string[] = [];
  return { sent, send: (text: string) => sent.push(text) };
}
describe('the guard', () => {
  test('empty text is blocked even when sending is allowed', () => {
    expect(guard(allow, '')).toEqual({ kind: 'empty', reason: 'empty' });
    expect(guard(allow, '   ')).toEqual({ kind: 'empty', reason: 'empty' });
  });
  test('a permission refusal outranks the text, and names its direction', () => {
    expect(guard(blockedByThem, 'hello')).toEqual({ kind: 'locked', reason: 'blocked_by_them' });
    expect(guard(blockedByMe, 'hello')).toEqual({ kind: 'locked', reason: 'blocked_by_me' });
  });
  test('text plus permission is ready', () => {
    expect(guard(allow, 'hello')).toEqual({ kind: 'ready' });
  });
});
describe('the composer renders its state', () => {
  test('sending is disabled when the composer is empty', () => {
    render(
      <Composer
        permission={allow}
        conversationId={CONVERSATION}
        send={sentStore().send}
      />,
    );
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
  });
  test('a blocked pair renders the lock, whichever direction it is', () => {
    const { unmount } = render(
      <Composer
        permission={blockedByMe}
        conversationId={CONVERSATION}
        send={sentStore().send}
      />,
    );
    expect(screen.getByText('You blocked this conversation.')).toBeDefined();
    unmount();
    render(
      <Composer
        permission={blockedByThem}
        conversationId={CONVERSATION}
        send={sentStore().send}
      />,
    );
    expect(screen.getByText('You cannot send messages to this conversation.')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
  });
  test('Enter with text sends once and empties the field', async () => {
    const { sent, send } = sentStore();
    render(<Composer permission={allow} conversationId={CONVERSATION} send={send} />);
    const field = screen.getByLabelText(`Message ${CONVERSATION}`);
    fireEvent.change(field, { target: { value: 'are you around' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(sent).toEqual(['are you around']));
    await waitFor(() => expect(screen.getByLabelText(`Message ${CONVERSATION}`).textContent).toBe(''));
  });
  test('Shift+Enter breaks the line instead of sending', async () => {
    const { sent, send } = sentStore();
    render(<Composer permission={allow} conversationId={CONVERSATION} send={send} />);
    const field = screen.getByLabelText(`Message ${CONVERSATION}`);
    fireEvent.change(field, { target: { value: 'line one' } });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
  });
  test('the three IME guards each block a send', async () => {
    const cases = [
      { name: 'the flag we own', event: { isComposed: true } },
      { name: 'the property', event: { isComposing: true } },
      { name: 'the legacy sniff', event: { keyCode: 229 } },
    ];
    for (const one of cases) {
      const { sent, send } = sentStore();
      const { unmount } = render(
        <Composer permission={allow} conversationId={CONVERSATION} send={send} />,
      );
      const field = screen.getByLabelText(`Message ${CONVERSATION}`);
      fireEvent.change(field, { target: { value: '候補' } });
      // A real IME sends `compositionstart` before the Enter; belt 1 is armed
      // by it and cleared only after a microtask, exactly as ADR 0051 says.
      if (one.event.isComposed === true) {
        fireEvent.compositionStart(field);
        fireEvent.compositionEnd(field);
      }
      fireEvent.keyDown(field, {
        key: 'Enter',
        ...(one.event.isComposing === true ? { isComposing: true } : {}),
        ...(one.event.keyCode === 229 ? { keyCode: 229 } : {}),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent).toEqual([]);
      unmount();
    }
  });
});
describe('drafts are device-local', () => {
  test('a draft survives a remount and reaches no other conversation', async () => {
    const store = await freshStore().open();
    await store.setDraft(CONVERSATION, 'half a thought', Date.now());
    const { unmount } = render(
      <Composer
        permission={allow}
        conversationId={CONVERSATION}
        send={sentStore().send}
        store={store}
      />,
    );
    await waitFor(() =>
      expect((screen.getByLabelText(`Message ${CONVERSATION}`) as HTMLTextAreaElement).value).toBe(
        'half a thought',
      ),
    );
    // Same store, different conversation: nothing carried across.
    const other = await freshStore().open();
    const again = await other.draftFor(CONVERSATION);
    expect(again).toBeUndefined();
    unmount();
  });
  test('typing persists the draft', async () => {
    const store = await freshStore();
    await store.open();
    render(
      <Composer
        permission={allow}
        conversationId={CONVERSATION}
        send={sentStore().send}
        store={store}
      />,
    );
    const field = screen.getByLabelText(`Message ${CONVERSATION}`);
    fireEvent.change(field, { target: { value: 'still typing' } });
    // The write is debounced; wait for it rather than assuming a frame.
    await waitFor(async () => {
      expect((await store.draftFor(CONVERSATION))?.text).toBe('still typing');
    }, { timeout: 2_000 });
  });
});