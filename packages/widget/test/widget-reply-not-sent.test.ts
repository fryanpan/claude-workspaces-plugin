import type { Thread } from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showThreadPopover } from '../src/widget-threads.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * A reply the server never took must not leave the popover looking sent.
 *
 * The submit handler read `if (!(await el.postReply(...))) return;`. A refusal
 * returned silently and a REJECTED fetch (server unreachable) left an
 * unhandled rejection — either way the popover sat there holding the words
 * with nothing said about them, which is the same thing a reply nobody had
 * pressed Reply on looks like.
 */

function widget(postReply: (id: string, text: string) => Promise<boolean>): FeedbackWidgetEl {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  return Object.assign(host, {
    shadow,
    user: { name: 'Ada', color: '#123456' },
    opts: { serverUrl: 'ws://host:8787', workspaceId: 'w-1', docId: 'd-1' },
    postReply,
    setStatus: async () => {},
  }) as unknown as FeedbackWidgetEl;
}

const thread = (): Thread =>
  ({
    id: 't1',
    status: 'open',
    anchor: { kind: 'subject' },
    comments: [{ id: 'c0', author: { name: 'Ada', color: '#123456' }, text: 'words', ts: 1 }],
  }) as unknown as Thread;

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function replyAndFail(postReply: () => Promise<boolean>) {
  const el = widget(postReply);
  showThreadPopover(el, thread(), 10, 10);
  const pop = el.shadow.querySelector('.thread-popover') as HTMLElement;
  const ta = pop.querySelector('textarea') as HTMLTextAreaElement;
  ta.value = 'Did this reach anyone?';
  (pop.querySelector('.submit') as HTMLElement).click();
  await flush();
  return { el, pop, ta };
}

describe('a widget reply the server refused', () => {
  it('keeps the popover, keeps the words, and says it did not send', async () => {
    const { el, pop, ta } = await replyAndFail(() => Promise.resolve(false));
    expect(el.shadow.querySelector('.thread-popover'), 'the popover was torn down').not.toBeNull();
    expect(ta.value).toBe('Did this reach anyone?');
    expect(pop.querySelector('.composer-err')?.textContent).toContain('Not sent');
  });

  it('says the same when the transport rejects outright', async () => {
    const { pop, ta } = await replyAndFail(() => Promise.reject(new Error('offline')));
    expect(ta.value).toBe('Did this reach anyone?');
    expect(pop.querySelector('.composer-err')?.textContent).toContain('Not sent');
  });

  it('editing the draft retires the note — those words are not the ones that failed', async () => {
    const { pop, ta } = await replyAndFail(() => Promise.resolve(false));
    expect(pop.querySelector('.composer-err')).not.toBeNull();
    ta.value = 'something else entirely';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(pop.querySelector('.composer-err')).toBeNull();
  });

  it('CONTROL: a reply that lands closes the popover and says nothing', async () => {
    const el = widget(() => Promise.resolve(true));
    showThreadPopover(el, thread(), 10, 10);
    const pop = el.shadow.querySelector('.thread-popover') as HTMLElement;
    (pop.querySelector('textarea') as HTMLTextAreaElement).value = 'landed';
    (pop.querySelector('.submit') as HTMLElement).click();
    await flush();
    expect(el.shadow.querySelector('.thread-popover')).toBeNull();
  });

  it('pressing Reply again after a refusal sends the same words again', async () => {
    const sent: string[] = [];
    const el = widget((_id, text) => {
      sent.push(text);
      return Promise.resolve(false);
    });
    showThreadPopover(el, thread(), 10, 10);
    const pop = el.shadow.querySelector('.thread-popover') as HTMLElement;
    (pop.querySelector('textarea') as HTMLTextAreaElement).value = 'try once more';
    (pop.querySelector('.submit') as HTMLElement).click();
    await flush();
    (pop.querySelector('.submit') as HTMLElement).click();
    await flush();
    expect(sent).toEqual(['try once more', 'try once more']);
  });
});
