/**
 * Fakes for the lead chat's voice path: a converse socket that records what
 * the page sent and lets a test answer as the server, and a microphone that
 * produces frames on demand. Nothing here opens a device or a connection.
 */
import type { SpokenServerMessage, SpokenSetup } from '@claude-workspaces/core/spoken-reply';
import type { SpokenCaptureOpts, SpokenCaptureStart } from '../src/board/spoken-reply-audio.ts';
import type { SpokenSocket } from '../src/board/spoken-reply-client.ts';
import type { LeadVoiceOpts } from '../src/lead-chat/lead-chat-voice.ts';

export class FakeSocket implements SpokenSocket {
  binaryType = '';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  closed = false;
  constructor(readonly url: string) {}
  send(d: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  serve(m: SpokenServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  /** The JSON frames the page sent, parsed. */
  messages(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  frames(): number {
    return this.sent.filter((d) => typeof d !== 'string').length;
  }
}

/** Which tab hears the reader, set by the test: hears until told otherwise. */
export function fakeTab() {
  const tab = { hears: true, joined: false, onChange: null as ((h: boolean) => void) | null };
  /** As the real one does: a tab out of the election hears. */
  const release = (): void => {
    if (!tab.joined) return;
    tab.joined = false;
    if (tab.hears) return;
    tab.hears = true;
    tab.onChange?.(true);
  };
  const make: NonNullable<LeadVoiceOpts['listeningTab']> = (o) => {
    tab.onChange = o.onChange;
    return {
      join: () => {
        tab.joined = true;
        tab.hears = true;
      },
      leave: () => release(),
      hears: () => tab.hears,
      destroy: () => release(),
    };
  };
  return {
    tab,
    make,
    /** Another tab took the reader, or this one got them back. */
    set: (hears: boolean) => {
      tab.hears = hears;
      tab.onChange?.(hears);
    },
  };
}

export function fakeVoice(opts: { setups?: SpokenSetup[] } = {}) {
  const tabs = fakeTab();
  const sockets: FakeSocket[] = [];
  const mic = { starts: 0, stops: 0, onFrame: null as SpokenCaptureOpts['onFrame'] | null };
  const seams: Partial<LeadVoiceOpts> = {
    fetchSetups: async () => opts.setups ?? [1],
    openSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    startCapture: async (c): Promise<SpokenCaptureStart> => {
      mic.starts++;
      mic.onFrame = c.onFrame;
      return { ok: true, capture: { stop: () => void mic.stops++ } };
    },
    playbackContext: () => null,
    blocked: () => null,
    storage: null,
    // A stop is reported to the page; here it would surface as an uncaught error.
    report: () => {},
    listeningTab: tabs.make,
  };
  return {
    seams,
    tabs,
    sockets,
    mic,
    socket: (): FakeSocket => {
      const s = sockets.at(-1);
      if (!s) throw new Error('no socket opened');
      return s;
    },
    speak: () => mic.onFrame?.(new Int16Array(800), true),
  };
}

/** Let the fetch of setups and the capture's start settle. */
export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
