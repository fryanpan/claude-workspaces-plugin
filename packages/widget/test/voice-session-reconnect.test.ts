import type { Anchor, VoiceTarget } from '@claude-workspaces/core';
import { describe, expect, it, vi } from 'vitest';
import { REDIAL_GIVE_UP_MS, REDIAL_STEPS_MS } from '../src/voice/voice-redial.ts';
import { VoiceSession } from '../src/voice/voice-session.ts';
import { FakeSocket, commentFrame, deferred, fakeMic, recordingPoster } from './voice-fakes.ts';

/**
 * A recording whose socket drops mid-way — a server restart, a network blip
 * — is opened again on a backoff while the microphone keeps listening. The
 * socket, the microphone, the thread routes and the clock are stand-ins, so
 * every redial is one the test fires by hand.
 */

const CATALOG: VoiceTarget[] = [{ i: 0, tag: 'h1', text: 'Goals' }];
const anchorFor = (): Anchor => ({ kind: 'subject' });

/** Started, connected, and the server's engine is up. */
async function recording() {
  const sockets: FakeSocket[] = [];
  const mic = fakeMic();
  const rec = recordingPoster();
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
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
    onChange: () => {},
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
  });
  const socket = (): FakeSocket => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket was opened');
    return s;
  };
  await session.start();
  socket().open();
  socket().recv({ type: 'ready', segment: 1 });
  return { session, sockets, socket, mic, rec, timers };
}

type Harness = Awaited<ReturnType<typeof recording>>;

describe('a socket that drops mid-recording', () => {
  /** The timers still waiting, as the redial schedules them. */
  const due = (t: Harness) => t.timers.filter((x) => !x.cleared);
  /** Run the one redial waiting; its wait in ms. */
  const fire = (t: Harness): number => {
    const next = due(t).find((x) => REDIAL_STEPS_MS.includes(x.ms as 250));
    if (!next) throw new Error('no redial is waiting');
    next.cleared = true;
    next.fn();
    return next.ms;
  };

  it('keeps recording, shows one steady reconnecting, and tries again on a backoff', async () => {
    const t = await recording();
    t.socket().drop();
    expect(t.session.state).toBe('recording');
    expect(t.session.reconnecting).toBe(true);
    expect(t.session.note).toBeNull();
    expect(t.mic.stops, 'the microphone keeps listening').toBe(0);
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      waits.push(fire(t));
      t.socket().drop();
      expect(t.session.reconnecting).toBe(true);
      expect(t.session.note).toBeNull();
    }
    expect(waits).toEqual([250, 500, 1000, 2000, 2000]);
    expect(t.sockets).toHaveLength(6);
  });

  it('sends what was said while down to the new socket once it is ready, then carries on', async () => {
    const t = await recording();
    t.socket().drop();
    const a = new Int16Array([1]);
    const b = new Int16Array([2]);
    t.mic.frame(a);
    fire(t);
    t.mic.frame(b);
    const next = t.socket();
    next.open();
    expect(next.json()[0]).toMatchObject({ type: 'start', targets: CATALOG });
    expect(next.audio(), 'held until the engine is ready').toEqual([]);
    next.recv({ type: 'ready', segment: 2 });
    expect(t.session.reconnecting).toBe(false);
    expect(next.audio()).toEqual([a, b]);
    const c = new Int16Array([3]);
    t.mic.frame(c);
    expect(next.audio()[2]).toBe(c);
    expect(due(t).some((x) => REDIAL_STEPS_MS.includes(x.ms as 250))).toBe(false);
  });

  it('names the new socket’s notes apart from the old one’s, which start again at v1', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', text: 'before' }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.posted).toBeTruthy());
    t.socket().drop();
    fire(t);
    t.socket().open();
    t.socket().recv({ type: 'ready', segment: 2 });
    t.socket().recv(commentFrame({ key: 'v1', text: 'after' }));
    await vi.waitFor(() => expect(t.session.comments.get('2.v1')?.posted).toBeTruthy());
    expect(t.session.comments.get('1.v1')?.text).toBe('before');
    expect(t.rec.calls.map((c) => c.op)).toEqual(['create', 'create']);
  });

  it('points the new socket where the person tapped while it was down', async () => {
    const t = await recording();
    t.socket().drop();
    t.session.pin(1);
    fire(t);
    t.socket().open();
    t.socket().recv({ type: 'ready', segment: 2 });
    expect(t.socket().json().at(-1)).toEqual({ type: 'pin', target: 1 });
  });

  it('leaves a write the old server refused as it went to that server, saying nothing', async () => {
    const t = await recording();
    const gate = deferred();
    t.rec.gate = gate.promise;
    t.rec.refuseCreate = true;
    t.socket().recv(commentFrame({ key: 'v1' }));
    t.socket().drop();
    gate.resolve();
    await vi.waitFor(() => expect(t.rec.calls).toHaveLength(1));
    // The refusal lands a few turns after the gate opens.
    await new Promise((r) => setTimeout(r, 0));
    expect(t.session.note).toBeNull();
    expect(t.session.comments.get('1.v1')?.refused).toBeFalsy();
  });

  it('ends and says so once the server has been gone two minutes', async () => {
    const t = await recording();
    t.socket().drop();
    let waited = 0;
    while (waited < REDIAL_GIVE_UP_MS) {
      waited += fire(t);
      t.socket().drop();
    }
    expect(t.session.state).toBe('idle');
    expect(t.session.reconnecting).toBe(false);
    expect(t.session.note).toBe('Voice feedback lost its connection.');
    expect(t.mic.stops).toBe(1);
  });

  it('Stop while down ends at once when nothing was said since', async () => {
    const t = await recording();
    t.socket().drop();
    t.session.stop();
    expect(t.session.state).toBe('idle');
    expect(due(t).some((x) => REDIAL_STEPS_MS.includes(x.ms as 250))).toBe(false);
  });

  it('Stop while down waits to send what was said, then stops on the new socket', async () => {
    const t = await recording();
    t.socket().drop();
    const a = new Int16Array([1]);
    t.mic.frame(a);
    t.session.stop();
    expect(t.session.state).toBe('stopping');
    fire(t);
    t.socket().open();
    t.socket().recv({ type: 'ready', segment: 2 });
    expect(t.socket().audio()).toEqual([a]);
    expect(t.socket().json().at(-1)).toEqual({ type: 'stop' });
  });
});
