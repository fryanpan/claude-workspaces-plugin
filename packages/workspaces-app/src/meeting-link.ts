/**
 * A meeting's connection to the server, with no page around it: the audio
 * socket, the few seconds of audio banked while it is down, and the backoff
 * that offers the same meeting id back after a drop.
 *
 * Taken out of `meeting-strip.ts` so that a meeting can be run by something
 * that is not a doc's top bar — the lead chat's meeting
 * (`lead-chat/lead-chat-meeting.ts`), which keeps one meeting going as the
 * reader moves from page to page. The strip still decides everything a
 * person sees; this module owns only the socket's own facts, which both
 * callers need in the same order:
 *
 *   - open → `start` frame → the banked frames replayed → live frames;
 *   - a frame sent before `ready` is also banked, because a handshake that
 *     never finishes takes everything sent on it (`ready` empties the bank);
 *   - a socket that ends on its own reports `dropped`, and the caller decides
 *     whether to `retry` with the meeting's id or to end.
 *
 * Why the bank is eight seconds and shared by every capture is in
 * `meeting-reconnect.ts`, beside the backoff it is sized against.
 */
import {
  type AudioHold,
  type ReconnectPlan,
  createAudioHold,
  createReconnectPlan,
} from './meeting-reconnect.ts';

/** The slice of a WebSocket a meeting uses — injectable so every state can be
 *  driven in a test without a server. */
export interface MeetingSocket {
  send(data: string | ArrayBufferView): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export function defaultOpenSocket(url: string): MeetingSocket {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return ws as unknown as MeetingSocket;
}

export interface MeetingLinkOpts {
  /** Where the socket opens, read at each connect. */
  url(): string;
  openSocket(url: string): MeetingSocket;
  now(): number;
  /** Run `fn` once after `ms`; returns a canceller. The backoff's clock. */
  schedule(fn: () => void, ms: number): () => void;
  /**
   * The `start` frame for this connection. `resume` is the meeting asked
   * back, and `heldMs` how much of the outage the replayed frames cover.
   */
  startFrame(c: { resume?: string; heldMs: number }): Record<string, unknown>;
  /** Called on open, before the start frame is sent. */
  beforeStart?(): void;
  /** Called after the start frame, before the banked frames are replayed. */
  afterStart?(): void;
  /** Every audio frame that actually went out, replayed or live. */
  frameSent?(): void;
  /** The handshake's frames are all sent. */
  opened?(sock: MeetingSocket): void;
  message(data: unknown, at: number): void;
  /** The socket ended on its own: decide whether to `retry`. */
  dropped(): void;
}

export interface MeetingLink {
  /** Open the socket and start, or resume, the meeting on it. */
  connect(resume?: string): void;
  /** Close deliberately: the handlers come off first, so no `dropped`. */
  close(): void;
  /** A text or binary frame on the open socket; dropped when there is none. */
  send(data: string | ArrayBufferView): void;
  /** One audio frame: sent when the socket is up, banked when it is not. */
  audio(pcm: ArrayBufferView): void;
  /**
   * The server answered `ready`. Empties the bank, resets the backoff, and
   * answers whether this connection had asked to resume.
   */
  ready(): boolean;
  /**
   * The socket dropped under a live meeting: close what is left and try
   * again after the backoff, if `stillWanted` says so then. `give-up` means
   * the backoff is spent.
   */
  retry(resume: string | undefined, stillWanted: () => boolean): 'retrying' | 'give-up';
  /** Call off a waiting retry and reset the backoff. */
  cancelRetry(): void;
  /** Throw away what is banked — a new meeting, or one that is over. */
  clearHold(): void;
  readonly open: boolean;
  /** The server has a meeting behind this socket (`ready` arrived). */
  readonly hasMeeting: boolean;
  /** The socket now open sent a `start` asking to resume. */
  readonly resuming: boolean;
  readonly socket: MeetingSocket | null;
}

export function createMeetingLink(opts: MeetingLinkOpts): MeetingLink {
  const { now } = opts;
  let socket: MeetingSocket | null = null;
  let open = false;
  let hasMeeting = false;
  let resuming = false;
  let cancelWait: (() => void) | null = null;
  const reconnect: ReconnectPlan = createReconnectPlan({ now });
  const hold: AudioHold = createAudioHold();

  const close = (): void => {
    const sock = socket;
    socket = null;
    open = false;
    resuming = false;
    if (!sock) return;
    // Handlers first: closing is a deliberate end, and an onclose that still
    // fired would report it as a dropped connection.
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
    hasMeeting = false;
    sock.close();
  };

  const connect = (resume?: string): void => {
    const sock = opts.openSocket(opts.url());
    socket = sock;
    resuming = resume !== undefined;
    sock.onopen = () => {
      open = true;
      // Read and kept, not taken: this socket can still die before `ready`,
      // and the retry after that needs the same frames. A first start takes
      // nothing and empties the bank — audio banked against a meeting nobody
      // is resuming belongs to no recording.
      const held = resume !== undefined ? hold.peek(now()) : { frames: [], heldMs: 0 };
      if (resume === undefined) hold.clear();
      opts.beforeStart?.();
      sock.send(
        JSON.stringify(
          opts.startFrame({ ...(resume !== undefined ? { resume } : {}), heldMs: held.heldMs }),
        ),
      );
      opts.afterStart?.();
      // Before any live frame: the server holds what arrives during the
      // handshake and delivers it in order, so a live frame sent ahead of the
      // replay would reach the transcript before the sentence it interrupted.
      for (const frame of held.frames) {
        sock.send(frame);
        opts.frameSent?.();
      }
      opts.opened?.(sock);
    };
    sock.onmessage = (ev) => {
      // The receive mark comes before the parse — the downlink ends when the
      // bytes land, not when they have been read.
      const at = now();
      opts.message(ev.data, at);
    };
    sock.onclose = () => {
      open = false;
      hasMeeting = false;
      opts.dropped();
    };
    // `error` is always followed by `close`; reporting both would say it twice.
    sock.onerror = null;
  };

  const cancelRetry = (): void => {
    cancelWait?.();
    cancelWait = null;
    reconnect.succeeded();
  };

  return {
    connect,
    close,
    send(data) {
      socket?.send(data);
    },
    audio(pcm) {
      if (!open) {
        hold.push(pcm, now());
        return;
      }
      // Open but not yet answered: sent AND banked, so a handshake that never
      // finishes can be said again on the next connection.
      if (!hasMeeting) hold.push(pcm, now());
      socket?.send(pcm);
      opts.frameSent?.();
    },
    ready() {
      const was = resuming;
      resuming = false;
      reconnect.succeeded();
      hasMeeting = true;
      hold.clear();
      return was;
    },
    retry(resume, stillWanted) {
      close();
      const step = reconnect.dropped();
      if (step.kind === 'give-up') return 'give-up';
      cancelWait = opts.schedule(() => {
        cancelWait = null;
        if (stillWanted()) connect(resume);
      }, step.delayMs);
      return 'retrying';
    },
    cancelRetry,
    clearHold() {
      hold.clear();
    },
    get open() {
      return open;
    },
    get hasMeeting() {
      return hasMeeting;
    },
    get resuming() {
      return resuming;
    },
    get socket() {
      return socket;
    },
  };
}
