import type { PcmCaptureOpts, PcmCaptureStart } from './voice/voice-audio.ts';

/**
 * The microphone for voice feedback on a served mock, held by the page around
 * the mock rather than by the mock's frame.
 *
 * The frame has an opaque origin (`server/src/mockup-frame.ts`), and Chrome
 * refuses `getUserMedia` there outright ("Invalid security origin") whatever
 * the frame's `allow` says; a frame with the board's own origin gets it. So
 * the host opens the microphone and streams it into the voice socket it
 * already holds for the frame (`mock-host.ts`). The frame's voice session asks
 * for the microphone and lets go of it over that socket's line
 * (`hostCapture` in `voice/voice-audio.ts`), and still reads what the server
 * says back — the words heard and the comments made — as it does at the top.
 *
 * The audio itself never enters the frame, so a mock's script cannot listen
 * to it. What a script can still do is ask for the microphone on this mock's
 * own voice socket: the host asks only while the page has a fresh user
 * activation (a tap in the mock is one), the browser shows that it is
 * recording, and the comments it makes are stamped as sent from inside the
 * mock like any other write from there.
 */

/** Frames held while the server opens its engine — as `VoiceSession` holds them. */
const MAX_HELD = 200;

export type MicReply =
  | { t: 'mic'; ok: true }
  | { t: 'mic'; ok: false; message: string }
  | {
      t: 'mic';
      heard: true;
    };

export interface HostMicDeps {
  /** Binary audio to the voice socket, once it is open and the engine ready. */
  send: (pcm: ArrayBuffer) => void;
  /** A reply down the frame's line. */
  reply: (msg: MicReply) => void;
  startCapture: (opts: PcmCaptureOpts) => Promise<PcmCaptureStart>;
  /** Whether the page has a user activation now (`navigator.userActivation`). */
  activated: () => boolean;
  /** What to say when there is none. */
  refusal: string;
}

export interface HostMic {
  /** The frame asked for the microphone (`true`) or let go of it. */
  ask(on: boolean): void;
  /** A text frame from the server: the engine's `ready` releases held audio. */
  serverSaid(data: unknown): void;
  /** The socket closed: the microphone goes with it. */
  close(): void;
  /**
   * Whether a frame's send may go on to the voice socket. Only words: the
   * audio on that socket is the host's own, so a mock's script cannot stream
   * sound of its own choosing in as the reader's voice.
   */
  passes(data: unknown): boolean;
}

export function createHostMic(deps: HostMicDeps): HostMic {
  let wanted = false;
  let starting = false;
  let capture: { stop(): void } | null = null;
  let ready = false;
  let heard = false;
  let held: ArrayBuffer[] = [];

  const release = (): void => {
    wanted = false;
    capture?.stop();
    capture = null;
    held = [];
  };

  const frame = (pcm: Int16Array): void => {
    if (!wanted) return;
    if (!heard) {
      heard = true;
      // The frame's session holds its Stop open for words said before the
      // engine was ready only when it has seen one; it gets a sign, not audio.
      deps.reply({ t: 'mic', heard: true });
    }
    const bytes = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    if (ready) deps.send(bytes);
    else if (held.length < MAX_HELD) held.push(bytes);
  };

  return {
    ask(on) {
      if (!on) {
        release();
        return;
      }
      if (wanted || starting) return;
      if (!deps.activated()) {
        deps.reply({ t: 'mic', ok: false, message: deps.refusal });
        return;
      }
      wanted = true;
      starting = true;
      void deps.startCapture({ onFrame: frame }).then((r) => {
        starting = false;
        if (!r.ok) {
          wanted = false;
          deps.reply({ t: 'mic', ok: false, message: r.message });
          return;
        }
        // Let go of, or closed, while the microphone was opening.
        if (!wanted) {
          r.capture.stop();
          return;
        }
        capture = r.capture;
        deps.reply({ t: 'mic', ok: true });
      });
    },
    serverSaid(data) {
      if (ready || typeof data !== 'string') return;
      try {
        if ((JSON.parse(data) as { type?: unknown }).type !== 'ready') return;
      } catch {
        return;
      }
      ready = true;
      for (const b of held) deps.send(b);
      held = [];
    },
    close: release,
    passes: (data) => typeof data === 'string',
  };
}
