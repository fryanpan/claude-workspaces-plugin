import { parseMeetingClientMessage } from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AudioPump,
  type MeetingCaptureStart,
  startMeetingCapture,
} from '../src/meeting-audio.ts';
import type { StartOneCapture } from '../src/meeting-capture-set.ts';
import {
  type MeetingSocket,
  NO_AUDIO_MS,
  NO_AUDIO_NOTE,
  mountMeetingStrip,
} from '../src/meeting-strip.ts';

/**
 * A recording whose microphone delivers nothing has to say so.
 *
 * Doc recordings on an iPad ended with zero turns and no error anywhere: the
 * audio graph produced no blocks, so no frame left the page, the track watch
 * (which ticks per block) never ran, and the strip showed a healthy meeting.
 * These pin the three things that make that visible and less likely — the
 * audio context made inside the Record tap, the strip's no-audio line with a
 * second resume, and the report the server logs.
 */

const SECURE = {
  isSecureContext: true,
  protocol: 'https:',
  hostname: 'example.test',
  port: '',
  pathname: '/review/d1',
  search: '',
};

function fakeStream(): MediaStream {
  const track = {
    stop: vi.fn(),
    applyConstraints: vi.fn(() => Promise.resolve()),
    readyState: 'live',
    muted: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
}

function fakeContext(): AudioContext {
  return { close: vi.fn(() => Promise.resolve()) } as unknown as AudioContext;
}

describe('the capture uses the context the tap made', () => {
  it('hands it to the first graph, and reports blocks and state from that graph', async () => {
    const context = fakeContext();
    const given: Array<AudioContext | undefined> = [];
    const pumps: AudioPump[] = [];
    const resume = vi.fn(() => Promise.resolve());
    const started = await startMeetingCapture({
      onFrame: () => {},
      context,
      deps: {
        readOrigin: () => SECURE,
        getMedia: () => Promise.resolve(fakeStream()),
        createPump: (_stream, ctx) => {
          given.push(ctx);
          const pump: AudioPump = {
            sampleRate: 48_000,
            onBlock: null,
            stop: vi.fn(),
            contextState: () => 'suspended',
            resume,
          };
          pumps.push(pump);
          return Promise.resolve(pump);
        },
      },
    });
    if (!started.ok) throw new Error('capture did not start');
    expect(given[0]).toBe(context);
    expect(started.capture.health?.()).toEqual({
      blocks: 0,
      contextState: 'suspended',
      sampleRate: 48_000,
    });
    pumps[0]?.onBlock?.(new Float32Array(128));
    expect(started.capture.health?.().blocks).toBe(1);
    await started.capture.resumeAudio?.();
    expect(resume).toHaveBeenCalledTimes(1);
    // A reopen is not a gesture: the replacement graph builds its own.
    await started.capture.reopen();
    expect(given[1]).toBeUndefined();
  });

  it('closes the tap’s context on an origin that cannot have a microphone', async () => {
    const context = fakeContext();
    const started = await startMeetingCapture({
      onFrame: () => {},
      context,
      deps: { readOrigin: () => ({ ...SECURE, isSecureContext: false, protocol: 'http:' }) },
    });
    expect(started.ok).toBe(false);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it('closes the tap’s context when the microphone is refused', async () => {
    const context = fakeContext();
    const started = await startMeetingCapture({
      onFrame: () => {},
      context,
      deps: {
        readOrigin: () => SECURE,
        getMedia: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })),
      },
    });
    expect(started.ok).toBe(false);
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});

class FakeSocket implements MeetingSocket {
  sent: Array<string | ArrayBufferView> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {}
  serve(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  frames(type: string): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>)
      .filter((m) => m.type === type);
  }
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.replaceChildren();
});

function mountStrip(o: { autoStart?: boolean } = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const sockets: FakeSocket[] = [];
  const watches: Array<{ fn: () => void; ms: number }> = [];
  const contexts: AudioContext[] = [];
  const calls: Array<Parameters<StartOneCapture>[0]> = [];
  const resumeAudio = vi.fn(() => Promise.resolve());
  let onFrame: ((pcm: Int16Array) => void) | null = null;
  const startCapture: StartOneCapture = (opts) => {
    calls.push(opts);
    onFrame = opts.onFrame;
    const started: MeetingCaptureStart = {
      ok: true,
      capture: {
        stop: vi.fn(),
        setEchoCancellation: () => Promise.resolve(),
        reopen: () => Promise.resolve({ ok: true as const }),
        health: () => ({ blocks: 0, contextState: 'suspended', sampleRate: 48_000 }),
        resumeAudio,
      },
    };
    return Promise.resolve(started);
  };
  const strip = mountMeetingStrip({
    docId: 'doc-1',
    root,
    alone: () => true,
    interval: () => () => {},
    schedule: () => () => {},
    captureWatch: (fn, ms) => {
      const entry = { fn, ms };
      watches.push(entry);
      return () => watches.splice(watches.indexOf(entry), 1);
    },
    createAudioContext: () => {
      const ctx = fakeContext();
      contexts.push(ctx);
      return ctx;
    },
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    startCapture,
    ...(o.autoStart ? { autoStart: true } : {}),
  });
  cleanups.push(() => strip.destroy());
  const record = () => root.querySelector('.meeting-record') as HTMLButtonElement;
  const alarm = () => root.querySelector('.meeting-stream-alarm')?.textContent ?? '';
  /** Open the socket and let the server say the meeting is live. */
  const goLive = () => {
    const sock = sockets[0] as FakeSocket;
    sock.onopen?.();
    sock.serve({ type: 'ready', meetingId: 'm-1', startedAt: 1, engine: 'soniox', mode: 'solo' });
    return sock;
  };
  return {
    root,
    sockets,
    watches,
    contexts,
    calls,
    resumeAudio,
    record,
    alarm,
    goLive,
    frame: () => onFrame?.(new Int16Array(800)),
    loud: () => onFrame?.(new Int16Array(800).fill(12_000)),
  };
}

describe('the Record tap makes the audio context before anything is awaited', () => {
  it('makes it inside the click and hands it to the capture', async () => {
    const h = mountStrip();
    h.record().click();
    // Synchronously: a context made after the first await is outside the
    // gesture, which is the Safari shape this exists to avoid.
    expect(h.contexts).toHaveLength(1);
    await settle();
    expect(h.calls[0]?.context).toBe(h.contexts[0]);
  });

  it('makes none for an automatic start, which is not a gesture', async () => {
    const h = mountStrip({ autoStart: true });
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.contexts).toHaveLength(0);
    expect(h.calls[0]?.context).toBeUndefined();
  });
});

describe('a recording with no audio leaving the page', () => {
  it('says so, resumes the context again, and tells the server what the graph looked like', async () => {
    const h = mountStrip();
    h.record().click();
    await settle();
    const sock = h.goLive();
    expect(h.watches).toHaveLength(1);
    expect(h.watches[0]?.ms).toBe(NO_AUDIO_MS);
    expect(h.alarm()).toBe('');

    h.watches[0]?.fn();

    expect(h.alarm()).toBe(NO_AUDIO_NOTE);
    expect(h.resumeAudio).toHaveBeenCalledTimes(1);
    const [report] = sock.frames('no_audio');
    expect(report).toEqual({
      type: 'no_audio',
      contextState: 'suspended',
      sampleRate: 48_000,
      blocks: 0,
    });
    // The server reads the same frame the strip wrote.
    expect(parseMeetingClientMessage(JSON.stringify(report))?.type).toBe('no_audio');

    // Audio arriving late clears the line.
    h.frame();
    expect(h.alarm()).toBe('');
  });

  it('stays quiet when frames are going out', async () => {
    const h = mountStrip();
    h.record().click();
    await settle();
    const sock = h.goLive();
    h.frame();
    h.watches[0]?.fn();
    expect(h.alarm()).toBe('');
    expect(sock.frames('no_audio')).toHaveLength(0);
    expect(h.resumeAudio).not.toHaveBeenCalled();
  });
});

describe('the Recording dot is steady', () => {
  it('does not change with the loudness of each frame', async () => {
    const h = mountStrip();
    h.record().click();
    await settle();
    h.goLive();
    const dot = h.root.querySelector('.meeting-record-dot') as HTMLElement;
    h.frame();
    const quiet = dot.getAttribute('style');
    h.loud();
    expect(dot.getAttribute('style')).toBe(quiet);
  });
});
