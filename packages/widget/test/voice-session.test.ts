import type { Anchor, VoiceTarget } from '@claude-workspaces/core';
import { describe, expect, it, vi } from 'vitest';
import { VoiceSession, type VoiceSessionDeps } from '../src/voice/voice-session.ts';
import { FakeSocket, commentFrame, deferred, fakeMic, recordingPoster } from './voice-fakes.ts';

/**
 * One recording, driven frame by frame: the page's socket, its microphone and
 * the thread routes are all stand-ins, so every test reads what the session
 * asked each of them to do.
 */

const CATALOG: VoiceTarget[] = [
  { i: 0, tag: 'h1', text: 'Goals' },
  { i: 1, tag: 'button', text: 'Done', parent: 0 },
];

/** Target index to a recognisable anchor, the way `voice-mode.ts` does it. */
const anchorFor = (target: number | null): Anchor =>
  target === null
    ? { kind: 'subject' }
    : ({ kind: 'element', snippet: { text: `#${target}` } } as unknown as Anchor);

function setup(over: Partial<VoiceSessionDeps> & { mic?: ReturnType<typeof fakeMic> } = {}) {
  const sockets: FakeSocket[] = [];
  const mic = over.mic ?? fakeMic();
  const rec = recordingPoster();
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const changes = { n: 0 };
  const session = new VoiceSession({
    url: 'ws://host/workspaces/w-1/docs/d-1/voice',
    openSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    startCapture: mic.start,
    poster: rec.poster,
    catalog: () => CATALOG,
    anchorFor,
    onChange: () => {
      changes.n += 1;
    },
    timers: {
      set: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clear: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    },
    ...over,
  });
  const socket = (): FakeSocket => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket was opened');
    return s;
  };
  return { session, sockets, socket, mic, rec, timers, changes };
}

/** Started, connected, and the server's engine is up. */
async function recording(over: Parameters<typeof setup>[0] = {}) {
  const t = setup(over);
  await t.session.start();
  t.socket().open();
  t.socket().recv({ type: 'ready', segment: 1 });
  return t;
}

describe('starting a recording', () => {
  it('opens the voice socket and describes the page once it is open', async () => {
    const t = setup();
    await t.session.start();
    expect(t.session.state).toBe('connecting');
    expect(t.socket().url).toBe('ws://host/workspaces/w-1/docs/d-1/voice');
    expect(t.socket().json(), 'nothing is sent before the socket opens').toEqual([]);
    t.socket().open();
    expect(t.socket().json()).toEqual([{ type: 'start', sampleRate: 16000, targets: CATALOG }]);
  });

  it('holds the audio heard before the engine is ready, and sends it in order after', async () => {
    const t = setup();
    await t.session.start();
    t.socket().open();
    const a = new Int16Array([1]);
    const b = new Int16Array([2]);
    const c = new Int16Array([3]);
    t.mic.frame(a);
    t.mic.frame(b);
    expect(t.socket().audio(), 'held while the engine opens').toEqual([]);
    t.socket().recv({ type: 'ready', segment: 1 });
    expect(t.session.state).toBe('recording');
    t.mic.frame(c);
    const sent = t.socket().audio();
    expect(sent).toHaveLength(3);
    expect(sent[0]).toBe(a);
    expect(sent[1]).toBe(b);
    expect(sent[2]).toBe(c);
  });

  it('ends with the server’s reason when voice is unavailable, and lets go of the microphone', async () => {
    const t = setup();
    await t.session.start();
    t.socket().open();
    t.socket().recv({ type: 'unavailable', reason: 'not_configured' });
    expect(t.session.state).toBe('idle');
    expect(t.session.note).toBe('Voice feedback is not set up on this server.');
    expect(t.mic.stops, 'the recording light goes out').toBe(1);
    expect(t.socket().closes).toEqual([1000]);
  });

  it('says so for a reason it has no words for', async () => {
    const t = setup();
    await t.session.start();
    t.socket().open();
    t.socket().recv({ type: 'unavailable', reason: 'something_new' });
    expect(t.session.note).toBe('Voice feedback is not available here.');
  });

  it('lets go of a microphone that finished opening after the server refused', async () => {
    const mic = fakeMic();
    mic.hold = true;
    const t = setup({ mic });
    const started = t.session.start();
    t.socket().open();
    t.socket().recv({ type: 'unavailable', reason: 'sign_in_required' });
    expect(t.session.note).toBe('Sign in to give voice feedback on this page.');
    mic.release();
    await started;
    expect(mic.stops, 'CONTROL: nothing was holding it open').toBe(1);
  });

  it('shows the microphone’s refusal and closes the socket', async () => {
    const t = setup({ mic: fakeMic({ message: 'No microphone was found.' }) });
    await t.session.start();
    expect(t.session.state).toBe('idle');
    expect(t.session.note).toBe('No microphone was found.');
    expect(t.socket().closes).toEqual([1000]);
  });

  it('keeps the last heard words and the server’s error for the page to show', async () => {
    const t = await recording();
    t.socket().recv({ type: 'heard', text: 'the goal bar' });
    expect(t.session.heard).toBe('the goal bar');
    t.socket().recv({ type: 'error', message: 'The transcriber hiccupped.' });
    expect(t.session.note).toBe('The transcriber hiccupped.');
    expect(t.session.state, 'an error is news, not the end').toBe('recording');
  });
});

describe('a spoken comment becoming a thread', () => {
  it('creates the thread on the first frame, anchored to its element, and tells the server', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', target: 1 }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.posted).toBeTruthy());
    expect(t.rec.calls).toEqual([
      {
        op: 'create',
        anchor: anchorFor(1),
        text: 'the goal bar is too tall',
        voice: {
          clip: '/workspaces/w-1/docs/d-1/voice-feedback/seg-1.wav#t=2,9',
          raw: 'um the goal bar is too tall',
        },
      },
    ]);
    expect(t.socket().json().at(-1)).toEqual({ type: 'posted', key: 'v1', threadId: 't1' });
  });

  it('anchors a comment about no element to the page as a whole', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', target: null }));
    await vi.waitFor(() => expect(t.rec.calls).toHaveLength(1));
    expect(t.rec.calls[0]).toMatchObject({ op: 'create', anchor: { kind: 'subject' } });
  });

  it('waits for words before creating anything', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', text: '  ' }));
    // A second comment written after it proves the first one's turn has come
    // and gone: its write was queued first.
    t.socket().recv(commentFrame({ key: 'v2', text: 'something else' }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v2')?.posted).toBeTruthy());
    expect(t.rec.calls.map((c) => ('text' in c ? c.text : c.op))).toEqual(['something else']);
    t.socket().recv(commentFrame({ key: 'v1', text: 'now there are words' }));
    await vi.waitFor(() => expect(t.rec.calls).toHaveLength(2));
    expect(t.rec.calls[1]).toMatchObject({ op: 'create', text: 'now there are words' });
  });

  it('edits the thread when the words grow', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', text: 'the goal bar' }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.posted).toBeTruthy());
    t.socket().recv(commentFrame({ key: 'v1', text: 'the goal bar is too tall', final: true }));
    await vi.waitFor(() => expect(t.rec.calls).toHaveLength(2));
    expect(t.rec.calls[1]).toMatchObject({
      op: 'edit',
      at: { threadId: 't1', commentId: 'c1' },
      text: 'the goal bar is too tall',
    });
  });

  it('writes nothing again for a frame that changed nothing', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1' }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.posted).toBeTruthy());
    t.socket().recv(commentFrame({ key: 'v1', final: true }));
    // A second, distinct comment is the positive control that writes are
    // still flowing when the first one's frame is judged.
    t.socket().recv(commentFrame({ key: 'v2', text: 'another thing' }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v2')?.posted).toBeTruthy());
    expect(t.rec.calls.map((c) => c.op)).toEqual(['create', 'create']);
  });

  it('moves the thread when the server names a different element', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', target: 0 }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.posted).toBeTruthy());
    t.socket().recv(commentFrame({ key: 'v1', target: 1 }));
    await vi.waitFor(() => expect(t.rec.calls).toHaveLength(2));
    expect(t.rec.calls[1]).toEqual({ op: 'reanchor', threadId: 't1', anchor: anchorFor(1) });
  });

  it('writes one comment one step at a time: a slow create then growth is create, then edit', async () => {
    const t = await recording();
    const slow = deferred();
    t.rec.gate = slow.promise;
    t.socket().recv(commentFrame({ key: 'v1', text: 'the goal' }));
    await vi.waitFor(() => expect(t.rec.calls).toHaveLength(1));
    // The words grow while the create is still out.
    t.socket().recv(commentFrame({ key: 'v1', text: 'the goal bar is too tall' }));
    slow.resolve();
    await vi.waitFor(() => expect(t.rec.calls).toHaveLength(2));
    expect(t.rec.calls.map((c) => c.op)).toEqual(['create', 'edit']);
    expect(t.rec.calls[0]).toMatchObject({ text: 'the goal' });
    expect(t.rec.calls[1]).toMatchObject({ text: 'the goal bar is too tall' });
  });

  it('keeps a refused comment’s words, says so, and posts it again on retry', async () => {
    const t = await recording();
    t.rec.refuseCreate = true;
    t.socket().recv(commentFrame({ key: 'v1' }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.refused).toBe(true));
    expect(t.session.note).toBe('A comment could not be saved. Its words are kept.');
    expect(
      t
        .socket()
        .json()
        .some((m) => m.type === 'posted'),
    ).toBe(false);

    t.rec.refuseCreate = false;
    t.session.retryRefused();
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.posted).toBeTruthy());
    expect(t.rec.calls.map((c) => c.op)).toEqual(['create', 'create']);
    expect(t.session.comments.get('1.v1')?.refused).toBe(false);
  });

  it('uses the host’s words for a refusal when it has some', async () => {
    const t = await recording({ refusedNote: () => 'Sign in to post. Your draft is kept.' });
    t.rec.refuseCreate = true;
    t.socket().recv(commentFrame({ key: 'v1' }));
    await vi.waitFor(() => expect(t.session.note).toBe('Sign in to post. Your draft is kept.'));
  });

  it('marks a refused edit and does not keep writing to that comment', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', text: 'one' }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.posted).toBeTruthy());
    t.rec.refuseEdit = true;
    t.socket().recv(commentFrame({ key: 'v1', text: 'one two' }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.refused).toBe(true));
    t.socket().recv(commentFrame({ key: 'v1', text: 'one two three' }));
    t.socket().recv(commentFrame({ key: 'v2', text: 'CONTROL: a different comment' }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v2')?.posted).toBeTruthy());
    expect(t.rec.calls.map((c) => c.op)).toEqual(['create', 'edit', 'create']);
  });

  it('spends the pin on the next new comment', async () => {
    const t = await recording();
    t.session.pin(1);
    expect(t.session.pinned).toBe(1);
    expect(t.socket().json().at(-1)).toEqual({ type: 'pin', target: 1 });
    t.socket().recv(commentFrame({ key: 'v1', target: 1 }));
    expect(t.session.pinned).toBeUndefined();
  });

  it('moves a growing comment through the server, and a settled one straight to its thread', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', target: null }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.posted).toBeTruthy());
    t.session.move('1.v1', 1);
    expect(t.socket().json().at(-1)).toEqual({ type: 'move', key: 'v1', target: 1 });
    await vi.waitFor(() => expect(t.rec.calls).toHaveLength(2));
    expect(t.rec.calls[1]).toEqual({ op: 'reanchor', threadId: 't1', anchor: anchorFor(1) });

    t.socket().recv(commentFrame({ key: 'v1', target: 1, final: true }));
    const before = t.socket().json().length;
    t.session.move('1.v1', 0);
    expect(t.socket().json().length, 'past the server’s reach').toBe(before);
    await vi.waitFor(() => expect(t.rec.calls).toHaveLength(3));
    expect(t.rec.calls[2]).toEqual({ op: 'reanchor', threadId: 't1', anchor: anchorFor(0) });
  });
});

describe('stopping', () => {
  it('stops the microphone at once, and finishes when the server has the last words', async () => {
    const t = await recording();
    t.session.stop();
    expect(t.mic.stops).toBe(1);
    expect(t.socket().json().at(-1)).toEqual({ type: 'stop' });
    expect(t.session.state).toBe('stopping');
    t.mic.frame(new Int16Array([9]));
    expect(t.socket().audio(), 'no audio after Stop').toEqual([]);
    t.socket().recv({ type: 'stopped' });
    expect(t.session.state).toBe('idle');
    expect(t.socket().closes).toEqual([1000]);
    expect(t.session.note).toBeNull();
    expect(t.timers[0]?.cleared, 'the give-up timer is cancelled').toBe(true);
  });

  it('gives up waiting for the server after the stop timer', async () => {
    const t = await recording();
    t.session.stop();
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]?.ms).toBe(30_000);
    t.timers[0]?.fn();
    expect(t.session.state).toBe('idle');
  });

  it('keeps words said before the engine was ready, and stops once it has them', async () => {
    const t = setup();
    await t.session.start();
    t.socket().open();
    const a = new Int16Array([1]);
    t.mic.frame(a);
    t.session.stop();
    expect(t.session.state, 'waiting for the engine, not given up').toBe('stopping');
    expect(t.mic.stops).toBe(1);
    expect(
      t
        .socket()
        .json()
        .some((m) => m.type === 'stop'),
      'no stop before the engine could hear the words',
    ).toBe(false);
    t.socket().recv({ type: 'ready', segment: 1 });
    expect(t.socket().audio()).toEqual([a]);
    expect(t.socket().json().at(-1)).toEqual({ type: 'stop' });
    t.socket().recv({ type: 'stopped' });
    expect(t.session.state).toBe('idle');
  });

  it('ends at once when stopped before anything was said', async () => {
    const t = setup();
    await t.session.start();
    t.socket().open();
    t.session.stop();
    expect(t.session.state).toBe('idle');
    expect(
      t
        .socket()
        .json()
        .some((m) => m.type === 'stop'),
    ).toBe(false);
  });

  it('says the connection was lost when the socket closes mid-recording', async () => {
    const t = await recording();
    t.socket().drop();
    expect(t.session.state).toBe('idle');
    expect(t.session.note).toBe('Voice feedback lost its connection.');
    expect(t.mic.stops).toBe(1);
  });

  it('CONTROL: a close while stopping is the expected end, not a lost connection', async () => {
    const t = await recording();
    t.session.stop();
    t.socket().drop();
    expect(t.session.state).toBe('idle');
    expect(t.session.note).toBeNull();
  });

  it('can start again after it finished', async () => {
    const t = await recording();
    t.socket().recv({ type: 'stopped' });
    await t.session.start();
    expect(t.sockets).toHaveLength(2);
    expect(t.session.state).toBe('connecting');
  });

  it('gives the next recording’s first comment a thread of its own, though the server names it v1 again', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', text: 'the goal bar is too tall', final: true }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.posted).toBeTruthy());
    t.socket().recv({ type: 'stopped' });

    await t.session.start();
    t.socket().open();
    t.socket().recv({ type: 'ready', segment: 2 });
    t.socket().recv(commentFrame({ key: 'v1', text: 'the Save button hides' }));
    await vi.waitFor(() => expect(t.session.comments.get('2.v1')?.posted).toBeTruthy());
    expect(t.rec.calls.map((c) => c.op)).toEqual(['create', 'create']);
    expect(t.session.comments.get('1.v1')?.text, 'the first comment keeps its words').toBe(
      'the goal bar is too tall',
    );
    expect(t.socket().json().at(-1)).toEqual({ type: 'posted', key: 'v1', threadId: 't2' });
  });

  it('does not name a comment of the next recording when an old create answers late', async () => {
    const t = await recording();
    const gate = deferred();
    t.rec.gate = gate.promise;
    t.socket().recv(commentFrame({ key: 'v1' }));
    t.socket().recv({ type: 'stopped' });
    await t.session.start();
    t.socket().open();
    t.socket().recv({ type: 'ready', segment: 2 });
    gate.resolve();
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.posted).toBeTruthy());
    expect(
      t
        .socket()
        .json()
        .some((m) => m.type === 'posted'),
      'the new recording’s v1 is not that thread',
    ).toBe(false);
    t.session.move('1.v1', 1);
    expect(
      t
        .socket()
        .json()
        .some((m) => m.type === 'move'),
      'nor is it moved through the new recording',
    ).toBe(false);
    await vi.waitFor(() =>
      expect(t.rec.calls.at(-1)).toMatchObject({ op: 'reanchor', threadId: 't1' }),
    );
  });
});

describe('undo and redo', () => {
  it('resolves and reopens the comment’s thread', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', final: true }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.posted).toBeTruthy());
    await t.session.setResolved('1.v1', true);
    expect(t.rec.calls.at(-1)).toEqual({ op: 'setResolved', threadId: 't1', resolved: true });
    expect(t.session.comments.get('1.v1')?.resolved).toBe(true);
    await t.session.setResolved('1.v1', false);
    expect(t.rec.calls.at(-1)).toEqual({ op: 'setResolved', threadId: 't1', resolved: false });
    expect(t.session.comments.get('1.v1')?.resolved).toBe(false);
  });

  it('CONTROL: a refused undo leaves the comment as it was', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', final: true }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.posted).toBeTruthy());
    t.rec.refuseResolve = true;
    await t.session.setResolved('1.v1', true);
    expect(t.rec.calls.at(-1)).toMatchObject({ op: 'setResolved' });
    expect(t.session.comments.get('1.v1')?.resolved).toBeUndefined();
  });
});
