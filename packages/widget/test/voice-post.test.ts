import { afterEach, describe, expect, it, vi } from 'vitest';
import { widgetPoster } from '../src/voice/voice-post.ts';
import { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * The thread routes a spoken comment is written through, against a recorded
 * `fetch`: which path each write takes, what it carries, and what the answer
 * is read as.
 */

const VOICE = { clip: '/workspaces/w-1/docs/d-1/voice-feedback/seg-1.wav#t=0,4', raw: 'um hi' };
const ANCHOR = { kind: 'subject' } as const;

function poster(respond: (url: string) => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      auth: (init.headers as Record<string, string>).authorization,
    });
    return respond(url);
  });
  const el = {
    opts: { serverUrl: 'ws://host:8787', workspaceId: 'w 1', docId: 'd-1' },
    user: { name: 'Ada', color: '#123456' },
    authToken: 'tok',
  } as unknown as FeedbackWidgetEl;
  return { p: widgetPoster(el), calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('writing a spoken comment through the thread routes', () => {
  it('creates a thread and reads back the thread and its first comment', async () => {
    const { p, calls } = poster(() => json({ thread: { id: 't9', comments: [{ id: 'c9' }] } }));
    expect(await p.create(ANCHOR, 'hi', VOICE)).toEqual({ threadId: 't9', commentId: 'c9' });
    expect(calls[0]?.url).toBe('http://host:8787/workspaces/w%201/docs/d-1/threads');
    expect(calls[0]?.body).toEqual({
      author: { name: 'Ada', color: '#123456' },
      text: 'hi',
      anchor: ANCHOR,
      voice: VOICE,
    });
    expect(calls[0]?.auth, 'signed like a typed comment').toBe('Bearer tok');
  });

  it('posts under the same author a typed comment on the same widget would', async () => {
    const { p, calls } = poster(() => json({ thread: { id: 't9', comments: [{ id: 'c9' }] } }));
    // The typed composer's own post, on a widget holding the same identity.
    const typed = Object.assign(Object.create(FeedbackWidgetEl.prototype), {
      opts: { serverUrl: 'ws://host:8787', workspaceId: 'w 1', docId: 'd-1' },
      user: { name: 'Ada', color: '#123456' },
      authToken: 'tok',
    }) as FeedbackWidgetEl;
    await typed.postNewThread(ANCHOR, 'typed');
    await p.create(ANCHOR, 'spoken', VOICE);
    const [typedCall, voiceCall] = calls;
    expect(typedCall?.body.text, 'CONTROL: the first write is the typed one').toBe('typed');
    expect(voiceCall?.body.author).toEqual(typedCall?.body.author);
    expect(voiceCall?.auth).toBe(typedCall?.auth);
  });

  it('reads back the author the server recorded, which a sign-in decides', async () => {
    const { p } = poster(() =>
      json({
        thread: { id: 't9', comments: [{ id: 'c9', author: { name: 'Reviewer' } }] },
      }),
    );
    expect(await p.create(ANCHOR, 'hi', VOICE)).toEqual({
      threadId: 't9',
      commentId: 'c9',
      author: 'Reviewer',
    });
  });

  it('reads a refused create, or an answer without a comment id, as nothing', async () => {
    expect(await poster(() => json({}, 500)).p.create(ANCHOR, 'hi', VOICE)).toBeNull();
    expect(
      await poster(() => json({ thread: { id: 't9', comments: [] } })).p.create(
        ANCHOR,
        'hi',
        VOICE,
      ),
    ).toBeNull();
  });

  it('edits the comment, and takes "unchanged" as done', async () => {
    const { p, calls } = poster(() => json({}, 409));
    expect(await p.edit({ threadId: 't9', commentId: 'c9' }, 'hi there', VOICE)).toBe(true);
    expect(calls[0]?.url).toBe(
      'http://host:8787/workspaces/w%201/docs/d-1/threads/t9/edit-comment',
    );
    expect(calls[0]?.body).toMatchObject({ commentId: 'c9', text: 'hi there', voice: VOICE });
    expect(
      await poster(() => json({}, 403)).p.edit({ threadId: 't9', commentId: 'c9' }, 'x', VOICE),
      'CONTROL: any other refusal is a refusal',
    ).toBe(false);
  });

  it('re-anchors, resolves and reopens on their own routes', async () => {
    const { p, calls } = poster(() => json({}));
    expect(await p.reanchor('t9', ANCHOR)).toBe(true);
    expect(await p.setResolved('t9', true)).toBe(true);
    expect(await p.setResolved('t9', false)).toBe(true);
    expect(
      calls.map((c) => c.url.replace('http://host:8787/workspaces/w%201/docs/d-1', '')),
    ).toEqual(['/threads/t9/reanchor', '/threads/t9/resolve', '/threads/t9/reopen']);
    expect(calls[0]?.body).toEqual({ anchor: ANCHOR });
  });
});
