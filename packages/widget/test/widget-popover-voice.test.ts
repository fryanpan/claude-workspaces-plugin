import type { Comment, Thread } from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showThreadPopover } from '../src/widget-threads.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * A spoken comment in the thread popover keeps what a typed one has no need
 * of: the clip it was heard in, and the words as heard before tidying.
 */

const CLIP = '/workspaces/w-1/docs/d-1/voice-feedback/seg-3.wav#t=12.4,31';

function widget(authToken: string | null = null): FeedbackWidgetEl {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  return Object.assign(host, {
    shadow,
    authToken,
    user: { name: 'Ada', color: '#123456' },
    opts: { serverUrl: 'ws://host:8787', workspaceId: 'w-1', docId: 'd-1' },
    postReply: async () => true,
    setStatus: async () => {},
  }) as unknown as FeedbackWidgetEl;
}

/** An `Audio` that records the src it was given, and what it played. */
function stubAudio(played: string[]): void {
  vi.stubGlobal(
    'Audio',
    class {
      constructor(readonly src: string) {}
      play() {
        played.push(this.src);
        return Promise.resolve();
      }
      pause() {}
    },
  );
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

  it('plays the clip from the widget’s server when its button is pressed', async () => {
    const played: string[] = [];
    stubAudio(played);
    const el = widget();
    showThreadPopover(el, thread([{ voice: { clip: CLIP, raw: 'x' } }]), 10, 10);
    (el.shadow.querySelector('[data-clip]') as HTMLElement).click();
    await vi.waitFor(() => expect(played).toEqual([`http://host:8787${CLIP}`]));
    (el.shadow.querySelector('.comment .body') as HTMLElement).click();
    expect(played, 'CONTROL: a tap elsewhere plays nothing').toHaveLength(1);
  });

  /**
   * On another project's page the clip is behind the tailnet widget door,
   * which asks every route but the two static scripts for the reviewer's
   * board token. An `<audio>` sets no Authorization header, so the bytes are
   * fetched and played from a blob instead.
   */
  it('fetches the clip with the reviewer’s token when it holds one', async () => {
    const played: string[] = [];
    stubAudio(played);
    const calls: Array<[string, HeadersInit | undefined]> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push([url, init?.headers]);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    vi.stubGlobal(
      'URL',
      Object.assign(Object.create(URL), URL, {
        createObjectURL: () => 'blob:cw-1',
        revokeObjectURL: () => {},
      }),
    );

    const el = widget('wt2.abc.def.ghi.jkl');
    showThreadPopover(el, thread([{ voice: { clip: CLIP, raw: 'x' } }]), 10, 10);
    (el.shadow.querySelector('[data-clip]') as HTMLElement).click();

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // The bare path, with no `#t=` on it — a fragment never leaves the
    // browser, and the range is applied to the blob below.
    expect(calls[0]?.[0]).toBe(`http://host:8787${CLIP.split('#')[0]}`);
    expect(calls[0]?.[1]).toEqual({ authorization: 'Bearer wt2.abc.def.ghi.jkl' });
    await vi.waitFor(() => expect(played).toEqual(['blob:cw-1#t=12.4,31']));
  });

  it('plays nothing when the door refuses the clip', async () => {
    const played: string[] = [];
    stubAudio(played);
    let asked = 0;
    vi.stubGlobal('fetch', async () => {
      asked += 1;
      return new Response('{"error":"sign_in_required"}', { status: 401 });
    });
    const el = widget('wt2.abc.def.ghi.jkl');
    showThreadPopover(el, thread([{ voice: { clip: CLIP, raw: 'x' } }]), 10, 10);
    (el.shadow.querySelector('[data-clip]') as HTMLElement).click();
    await vi.waitFor(() => expect(asked).toBe(1));
    expect(played).toEqual([]);
  });
});
