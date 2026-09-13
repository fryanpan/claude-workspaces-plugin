import type { Comment, Thread } from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showThreadPopover } from '../src/widget-threads.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * A spoken comment in the thread popover keeps what a typed one has no need
 * of: the clip it was heard in, and the words as heard before tidying.
 */

const CLIP = '/workspaces/w-1/docs/d-1/voice-feedback/seg-3.wav#t=12.4,31';

function widget(): FeedbackWidgetEl {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  return Object.assign(host, {
    shadow,
    user: { name: 'Ada', color: '#123456' },
    opts: { serverUrl: 'ws://host:8787', workspaceId: 'w-1', docId: 'd-1' },
    postReply: async () => true,
    setStatus: async () => {},
  }) as unknown as FeedbackWidgetEl;
}

function thread(comments: Array<Partial<Comment>>): Thread {
  return {
    id: 't1',
    status: 'open',
    anchor: { kind: 'subject' },
    comments: comments.map((c, i) => ({
      id: `c${i}`,
      author: { name: 'Ada', color: '#123456' },
      text: 'words',
      ts: 1,
      ...c,
    })),
  } as unknown as Thread;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('a voice comment in the thread popover', () => {
  it('offers its clip and its raw words; a typed comment beside it offers neither', () => {
    const el = widget();
    showThreadPopover(
      el,
      thread([
        { text: 'The goal bar is too tall.', voice: { clip: CLIP, raw: 'um the <goal> bar' } },
        { text: 'Agreed, typed.' },
      ]),
      10,
      10,
    );
    const rows = el.shadow.querySelectorAll('.thread-popover .comment');
    expect(rows).toHaveLength(2);
    const [spoken, typed] = [rows[0] as HTMLElement, rows[1] as HTMLElement];

    expect(spoken.querySelector('[data-clip]')?.getAttribute('data-clip')).toBe(CLIP);
    const details = spoken.querySelector('.vnote details') as HTMLDetailsElement;
    expect(details.querySelector('summary')?.textContent).toBe('Raw words');
    expect(details.textContent).toBe('Raw wordsum the <goal> bar');
    expect(details.querySelector('goal'), 'the raw words are text, not markup').toBeNull();

    expect(typed.querySelector('.vnote')).toBeNull();
    expect(typed.querySelector('[data-clip]')).toBeNull();
  });

  it('plays the clip from the widget’s server when its button is pressed', () => {
    const played: string[] = [];
    vi.stubGlobal(
      'Audio',
      class {
        constructor(readonly src: string) {}
        play() {
          played.push(this.src);
          return Promise.resolve();
        }
      },
    );
    const el = widget();
    showThreadPopover(el, thread([{ voice: { clip: CLIP, raw: 'x' } }]), 10, 10);
    (el.shadow.querySelector('[data-clip]') as HTMLElement).click();
    expect(played).toEqual([`http://host:8787${CLIP}`]);
    (el.shadow.querySelector('.comment .body') as HTMLElement).click();
    expect(played, 'CONTROL: a tap elsewhere plays nothing').toHaveLength(1);
  });
});
