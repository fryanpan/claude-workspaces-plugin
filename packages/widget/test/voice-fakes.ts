import type { Anchor, VoiceNote } from '@claude-workspaces/core';
import type { PcmCaptureOpts, PcmCaptureStart } from '../src/voice/voice-audio.ts';
import type { PostedComment, VoicePoster } from '../src/voice/voice-post.ts';
import type { SocketLike } from '../src/voice/voice-session.ts';

/**
 * Stand-ins for the three things a recording talks to — the relay's socket,
 * the microphone and the thread routes — so a test drives a recording frame
 * by frame and reads back what each one was asked to do.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet.
 */

/** The relay's socket: records what the page sent, and lets a test speak for the server. */
export class FakeSocket implements SocketLike {
  binaryType = '';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  readonly closes: Array<number | undefined> = [];

  constructor(readonly url: string) {}

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closes.push(code);
    this.readyState = 3;
  }
  /** The server accepted the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** A frame from the server. */
  recv(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** The connection went away without anyone asking. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  /** The JSON frames the page sent, parsed. */
  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  /** The audio frames the page sent, in order. */
  audio(): Int16Array[] {
    return this.sent.filter((d): d is Int16Array => d instanceof Int16Array);
  }
}

/** The microphone: hands out frames when the test says so. */
export function fakeMic(result: 'ok' | { message: string } = 'ok') {
  const mic = {
    stops: 0,
    opts: null as PcmCaptureOpts | null,
    /** Resolves the capture's start; held until `release` when `hold` was set. */
    hold: false,
    release: (): void => {},
    start: (opts: PcmCaptureOpts): Promise<PcmCaptureStart> => {
      mic.opts = opts;
      const answer: PcmCaptureStart =
        result === 'ok'
          ? {
              ok: true,
              capture: {
                stop: () => {
                  mic.stops += 1;
                },
              },
            }
          : { ok: false, message: result.message };
      if (!mic.hold) return Promise.resolve(answer);
      return new Promise((resolve) => {
        mic.release = () => resolve(answer);
      });
    },
    frame(pcm: Int16Array): void {
      mic.opts?.onFrame(pcm);
    },
  };
  return mic;
}

export type PosterCall =
  | { op: 'create'; anchor: Anchor; text: string; voice: VoiceNote }
  | { op: 'edit'; at: PostedComment; text: string; voice: VoiceNote }
  | { op: 'reanchor'; threadId: string; anchor: Anchor }
  | { op: 'setResolved'; threadId: string; resolved: boolean };

/**
 * The thread routes. Every call is recorded; each answers at once unless the
 * test parked it with `gate`, in which case it waits for `open()`.
 */
export function recordingPoster() {
  let n = 0;
  const calls: PosterCall[] = [];
  const state = {
    calls,
    refuseCreate: false,
    refuseEdit: false,
    refuseReanchor: false,
    refuseResolve: false,
    /** When set, the next write waits for it to resolve. */
    gate: null as Promise<void> | null,
  };
  const wait = async (): Promise<void> => {
    const g = state.gate;
    state.gate = null;
    if (g) await g;
  };
  const poster: VoicePoster = {
    async create(anchor, text, voice) {
      calls.push({ op: 'create', anchor, text, voice });
      await wait();
      if (state.refuseCreate) return null;
      n += 1;
      return { threadId: `t${n}`, commentId: `c${n}` };
    },
    async edit(at, text, voice) {
      calls.push({ op: 'edit', at, text, voice });
      await wait();
      return !state.refuseEdit;
    },
    async reanchor(threadId, anchor) {
      calls.push({ op: 'reanchor', threadId, anchor });
      await wait();
      return !state.refuseReanchor;
    },
    async setResolved(threadId, resolved) {
      calls.push({ op: 'setResolved', threadId, resolved });
      await wait();
      return !state.refuseResolve;
    },
  };
  return Object.assign(state, { poster });
}

/** A promise and the function that settles it. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A comment frame, with the fields a test does not care about filled in. */
export function commentFrame(
  over: Partial<{
    key: string;
    text: string;
    raw: string;
    clip: string;
    target: number | null;
    final: boolean;
  }> = {},
) {
  return {
    type: 'comment',
    key: 'v1',
    text: 'the goal bar is too tall',
    raw: 'um the goal bar is too tall',
    clip: '/workspaces/w-1/docs/d-1/voice-feedback/seg-1.wav#t=2,9',
    target: null,
    final: false,
    ...over,
  };
}
