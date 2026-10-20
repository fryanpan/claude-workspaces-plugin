import type { Thread } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { showThreadPopover } from '../src/widget-threads.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * Enter sends a reply from a thread's popover, as it sends a new comment.
 *
 * Bryan, on a mock: "I can't reply with enter". The new-comment box sent on
 * Enter (`submitOnEnter`, `widget-picker.ts`) and the thread's reply box had
 * no key handler at all, so Enter only added a line. Same rule in both now:
 * Enter sends, Shift+Enter is a new line, and an IME's Enter picks its
 * candidate.
 */

function widget(sent: string[]): FeedbackWidgetEl {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  return Object.assign(host, {
    shadow,
    user: { name: 'Alice', color: '#123456' },
    opts: { serverUrl: 'ws://host:1', workspaceId: 'w-1', docId: 'd-1' },
    postReply: (_id: string, text: string) => {
      sent.push(text);
      return Promise.resolve(true);
    },
    setStatus: async () => {},
  }) as unknown as FeedbackWidgetEl;
}

const thread = (): Thread =>
  ({
    id: 't1',
    status: 'open',
    anchor: { kind: 'subject' },
    comments: [{ id: 'c0', author: { name: 'Bob', color: '#123456' }, text: 'Which pier?', ts: 1 }],
  }) as unknown as Thread;

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Open the popover, type `words`, press Enter with `init`; what was sent and
 *  whether the keystroke was left to the textarea. */
async function press(words: string, init: KeyboardEventInit) {
  const sent: string[] = [];
  const el = widget(sent);
  showThreadPopover(el, thread(), 10, 10);
  const ta = el.shadow.querySelector('.thread-popover textarea') as HTMLTextAreaElement;
  ta.value = words;
  const ev = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  ta.dispatchEvent(ev);
  await flush();
  return { sent, kept: !ev.defaultPrevented, open: !!el.shadow.querySelector('.thread-popover') };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Enter in a thread reply box', () => {
  it('sends the reply and closes the popover', async () => {
    const r = await press('Riverbend pier', {});
    expect(r.sent).toEqual(['Riverbend pier']);
    expect(r.kept).toBe(false);
    expect(r.open).toBe(false);
  });

  it('adds a new line with Shift held, and sends nothing', async () => {
    const r = await press('first line', { shiftKey: true });
    expect(r.sent).toEqual([]);
    expect(r.kept).toBe(true);
    expect(r.open).toBe(true);
  });

  it('does nothing while an IME is composing', async () => {
    const r = await press('はし', { isComposing: true });
    expect(r.sent).toEqual([]);
    expect(r.kept).toBe(true);
  });

  it('CONTROL: another key sends nothing', async () => {
    const sent: string[] = [];
    const el = widget(sent);
    showThreadPopover(el, thread(), 10, 10);
    const ta = el.shadow.querySelector('.thread-popover textarea') as HTMLTextAreaElement;
    ta.value = 'typing';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await flush();
    expect(sent).toEqual([]);
  });
});
