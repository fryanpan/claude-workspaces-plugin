import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import type { PlaybackContext, SpokenCaptureOpts } from '../../src/board/spoken-reply-audio.ts';
import {
  type SpokenReplyOpts,
  type SpokenSocket,
  createSpokenReply,
} from '../../src/board/spoken-reply-client.ts';

/**
 * The spoken reply client, driven end to end on the page with the
 * server, the microphone and the speaker replaced: a socket whose frames the
 * test reads and answers, a capture that emits the frames the test says, and
 * an audio context whose clock the test holds.
 */

export class FakeSocket implements SpokenSocket {
  binaryType = '';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  send(d: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  frames(): number {
    return this.sent.filter((d) => typeof d !== 'string').length;
  }
  reply(m: SpokenServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  audio(samples: number[]): void {
    const b = new Uint8Array(samples.length * 2);
    const v = new DataView(b.buffer);
    samples.forEach((s, i) => v.setInt16(i * 2, s, true));
    this.onmessage?.({ data: b.buffer });
  }
}

export function fakePlayback() {
  const started: number[] = [];
  let stopped = 0;
  const ctx = {
    currentTime: 1,
    state: 'running',
    resume: async () => {},
    destination: {} as AudioNode,
    createBuffer: (_c: number, length: number, sampleRate: number) =>
      ({ length, sampleRate, copyToChannel: () => {} }) as unknown as AudioBuffer,
    createBufferSource: () =>
      ({
        buffer: null,
        connect: () => {},
        start: (t: number) => started.push(t),
        stop: () => {
          stopped++;
        },
        onended: null,
      }) as unknown as AudioBufferSourceNode,
  };
  return {
    ctx: ctx as unknown as PlaybackContext,
    started,
    get stopped() {
      return stopped;
    },
  };
}

export function spokenHarness(over: Partial<SpokenReplyOpts> = {}) {
  const mic = document.createElement('button');
  mic.id = 'spoken-mic';
  document.body.append(mic);
  const sockets: FakeSocket[] = [];
  const captures: SpokenCaptureOpts[] = [];
  let captureStops = 0;
  let clock = 1000;
  const play = fakePlayback();
  const store = new Map<string, string>();
  const navigated: string[] = [];
  const reply = createSpokenReply({
    document,
    button: mic,
    url: 'ws://board.test/workspaces/w-1/voice/converse',
    setups: [1, 2],
    timings: {},
    author: { id: 'u-1', name: 'Alice', kind: 'known' },
    getContext: () => ({ taskId: 't-1' }),
    onNavigate: (u) => navigated.push(u),
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    startCapture: async (o) => {
      captures.push(o);
      return {
        ok: true,
        capture: {
          stop: () => {
            captureStops++;
          },
        },
      };
    },
    captureContext: () => undefined,
    playbackContext: () => play.ctx,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    now: () => clock,
    ...over,
  });
  return {
    reply,
    panel: reply.panel,
    mic,
    sockets,
    get socket() {
      const s = sockets.at(-1);
      if (!s) throw new Error('no socket');
      return s;
    },
    captures,
    get captureStops() {
      return captureStops;
    },
    play,
    store,
    navigated,
    tick: (ms: number) => {
      clock += ms;
    },
    /** One 50 ms frame, loud or quiet. */
    frame: (loud: boolean) =>
      captures.at(-1)?.onFrame(new Int16Array(800).fill(loud ? 3000 : 0), loud),
    text: () => reply.panel.root.textContent ?? '',
    label: () => reply.panel.root.querySelector('.vr-state')?.textContent,
  };
}
