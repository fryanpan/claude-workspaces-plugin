/**
 * Voice feedback on a served mock: the page around the mock holds the
 * microphone, because the mock's frame cannot, and streams it into the voice
 * socket it already holds for the frame. The frame asks for it and lets go of
 * it; the audio never goes to the frame.
 *
 * Driven with a stand-in capture whose frames a test pushes by hand, and a
 * stand-in bridge socket for the frame's half.
 */
import { describe, expect, it } from 'vitest';
import { type MicReply, createHostMic } from '../src/mock-host-mic.ts';
import type { PcmCaptureOpts, PcmCaptureStart } from '../src/voice/voice-audio.ts';
import { hostCapture } from '../src/voice/voice-audio.ts';

function harness(opts: { activated?: boolean; refuse?: string } = {}) {
  const sent: ArrayBuffer[] = [];
  const replies: MicReply[] = [];
  const captures: Array<{ onFrame: (pcm: Int16Array) => void; stops: number }> = [];
  let resolveStart: ((r: PcmCaptureStart) => void) | null = null;
  const mic = createHostMic({
    send: (pcm) => sent.push(pcm),
    reply: (m) => replies.push(m),
    activated: () => opts.activated ?? true,
    refusal: 'blocked',
    startCapture: (o: PcmCaptureOpts) =>
      new Promise<PcmCaptureStart>((resolve) => {
        const c = { onFrame: o.onFrame, stops: 0 };
        captures.push(c);
        resolveStart = resolve;
        if (opts.refuse) resolve({ ok: false, message: opts.refuse });
      }),
  });
  const open = async () => {
    resolveStart?.({
      ok: true,
      capture: {
        stop() {
          const c = captures.at(-1);
          if (c) c.stops += 1;
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
  };
  return { mic, sent, replies, captures, open };
}

const pcm = (...s: number[]) => Int16Array.from(s);
const bytes = (b: ArrayBuffer) => [...new Int16Array(b)];

describe('the host holds the mock page’s microphone', () => {
  it('holds audio until the engine is ready, then streams it, and never answers with audio', async () => {
    const h = harness();
    h.mic.ask(true);
    await h.open();
    expect(h.replies).toEqual([{ t: 'mic', ok: true }]);

    h.captures[0]?.onFrame(pcm(1, 2));
    h.captures[0]?.onFrame(pcm(3));
    expect(h.sent).toEqual([]);
    // Only the first frame is announced to the frame, and only as a sign.
    expect(h.replies).toEqual([
      { t: 'mic', ok: true },
      { t: 'mic', heard: true },
    ]);

    h.mic.serverSaid('{"type":"heard","text":"ready"}');
    h.mic.serverSaid(new ArrayBuffer(2));
    expect(h.sent).toEqual([]);
    h.mic.serverSaid('{"type":"ready","segment":1}');
    expect(h.sent.map(bytes)).toEqual([[1, 2], [3]]);

    h.captures[0]?.onFrame(pcm(4));
    expect(h.sent.map(bytes)).toEqual([[1, 2], [3], [4]]);
    expect(h.replies).toHaveLength(2);
  });

  it('asks for the microphone only while the page has a user activation', async () => {
    const h = harness({ activated: false });
    h.mic.ask(true);
    expect(h.captures).toHaveLength(0);
    expect(h.replies).toEqual([{ t: 'mic', ok: false, message: 'blocked' }]);
  });

  it('passes on the browser’s refusal', async () => {
    const h = harness({ refuse: 'No microphone was found.' });
    h.mic.ask(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.replies).toEqual([{ t: 'mic', ok: false, message: 'No microphone was found.' }]);
  });

  it('lets go of the microphone on Stop and on close, and drops what it held', async () => {
    const h = harness();
    h.mic.ask(true);
    await h.open();
    h.captures[0]?.onFrame(pcm(9));
    h.mic.ask(false);
    expect(h.captures[0]?.stops).toBe(1);
    h.captures[0]?.onFrame(pcm(10));
    h.mic.serverSaid('{"type":"ready"}');
    expect(h.sent).toEqual([]);

    const g = harness();
    g.mic.ask(true);
    await g.open();
    g.mic.close();
    expect(g.captures[0]?.stops).toBe(1);
  });

  it('passes on only words from the frame to the voice socket, never audio', () => {
    const { mic } = harness();
    expect(mic.passes('{"type":"pin","target":3}')).toBe(true);
    expect([new ArrayBuffer(4), new Blob(['x']), new Uint8Array(2), null].map(mic.passes)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('stops a microphone that finished opening after it was let go of', async () => {
    const h = harness();
    h.mic.ask(true);
    h.mic.ask(true);
    expect(h.captures).toHaveLength(1);
    h.mic.ask(false);
    await h.open();
    expect(h.captures[0]?.stops).toBe(1);
    expect(h.replies).toEqual([]);
  });
});

describe('the frame’s half: asking the host for the microphone', () => {
  it('asks over the socket, marks the first frame heard with an empty one, and lets go on stop', async () => {
    const calls: Array<boolean> = [];
    let heard: (() => void) | undefined;
    const socket = {
      cwMic(on: boolean, h?: () => void) {
        calls.push(on);
        if (on) heard = h;
        return Promise.resolve({ ok: true });
      },
    };
    const frames: Int16Array[] = [];
    const started = await hostCapture(socket, { onFrame: (f) => frames.push(f) });
    expect(started.ok).toBe(true);
    heard?.();
    expect(frames.map((f) => f.length)).toEqual([0]);
    if (started.ok) started.capture.stop();
    expect(calls).toEqual([true, false]);
  });

  it('says the microphone is blocked on a socket with no host behind it, or when the host refuses', async () => {
    expect(await hostCapture({}, { onFrame: () => {} })).toEqual({
      ok: false,
      message: 'The microphone is blocked for this page. Allow it in the browser’s site settings.',
    });
    const refusing = {
      cwMic: () => Promise.resolve({ ok: false, message: 'No microphone was found.' }),
    };
    expect(await hostCapture(refusing, { onFrame: () => {} })).toEqual({
      ok: false,
      message: 'No microphone was found.',
    });
  });
});
