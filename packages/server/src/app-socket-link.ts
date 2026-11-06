/**
 * The connection from this server to an attached app's dev server, for one
 * reader's websocket (`routes/app-socket.ts` decides who gets one).
 *
 * ── Dial first ──
 *
 * The upstream is dialled before the reader's handshake is answered, for two
 * reasons. A subprotocol is chosen by the dev server and the 101 has to name
 * it. And a reader must not see a socket open while the dev server is down:
 * Vite's client takes a socket that opens as proof the server is back, then
 * reloads the page, so a proxy that answered 101 by itself would reload an
 * app that is not running, once a second.
 *
 * ── What crosses ──
 *
 * Frames, text or binary, as they were sent, and the close code and reason.
 * No header of the reader's: `loopbackSocket` sends none. A dev server speaks
 * first (Vite's `connected`), so what arrives before the reader's socket has
 * opened is held, up to `HELD_MAX_BYTES`. A dev server that writes more than
 * that into a socket nobody has yet closes it.
 *
 * Either side closing closes the other, so a reader who leaves frees the
 * dev server's connection, and a restarted dev server tells the reader.
 */
import { loopbackSocket } from './outbound-fetch.ts';

/** How long a dev server has to answer a handshake. */
const DIAL_MS = 5000;
/** What is held for a reader whose socket has not opened yet. */
const HELD_MAX_BYTES = 1024 * 1024;
/** What a reader is told when the dev server went away with no close frame. */
const WENT_AWAY = 1001;

/** The part of the reader's socket this side uses. */
export interface AppSocketClient {
  send(data: string | ArrayBuffer): number;
  close(code?: number, reason?: string): void;
}

/**
 * A code one side may be told. RFC 6455 reserves 1004, 1005, 1006 and 1015:
 * they report what a peer saw and are never sent. A browser reports 1006 when
 * a dev server's process dies, so this is the common case on a restart.
 */
export function relayableCloseCode(code: number): number {
  const sendable =
    code === 1000 ||
    (code >= 1001 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999);
  return sendable ? code : WENT_AWAY;
}

export class AppSocketLink {
  private client: AppSocketClient | null = null;
  private held: Array<string | ArrayBuffer> = [];
  private heldBytes = 0;
  private ended: { code: number; reason: string } | null = null;

  constructor(private readonly upstream: WebSocket) {
    upstream.onmessage = (ev) => this.fromUpstream(ev.data as string | ArrayBuffer);
    upstream.onclose = (ev) => this.upstreamClosed(ev.code, ev.reason);
  }

  /** The subprotocol the dev server chose, or empty. */
  get protocol(): string {
    return this.upstream.protocol;
  }

  /** The reader's socket opened: hand over what was held. */
  attach(client: AppSocketClient): void {
    this.client = client;
    const held = this.held;
    this.held = [];
    this.heldBytes = 0;
    for (const frame of held) this.deliver(frame);
    if (this.ended) client.close(relayableCloseCode(this.ended.code), this.ended.reason);
  }

  fromClient(message: string | ArrayBufferView): void {
    if (this.upstream.readyState === WebSocket.OPEN) this.upstream.send(message);
  }

  clientClosed(code: number, reason: string): void {
    this.client = null;
    this.closeUpstream(code, reason);
  }

  /** The reader's handshake never completed. */
  abandon(): void {
    this.closeUpstream(1001, '');
  }

  private closeUpstream(code: number, reason: string): void {
    try {
      this.upstream.close(relayableCloseCode(code), reason);
    } catch {
      // A client may refuse a code a server may send; the socket still goes.
      this.upstream.close();
    }
  }

  private fromUpstream(frame: string | ArrayBuffer): void {
    if (this.client) {
      this.deliver(frame);
      return;
    }
    this.heldBytes += typeof frame === 'string' ? frame.length : frame.byteLength;
    if (this.heldBytes > HELD_MAX_BYTES) {
      this.held = [];
      this.closeUpstream(1009, 'held frames over limit');
      return;
    }
    this.held.push(frame);
  }

  private deliver(frame: string | ArrayBuffer): void {
    // Zero is a frame dropped: this reader has stopped keeping up, and a
    // reload channel with a hole in it would leave the page wrong.
    if (this.client?.send(frame) === 0) this.client.close(1013, 'reader fell behind');
  }

  private upstreamClosed(code: number, reason: string): void {
    if (this.client) this.client.close(relayableCloseCode(code), reason);
    else this.ended = { code, reason };
  }
}

/**
 * Connect to a dev server, or answer null when nothing there takes the
 * handshake: nothing listening, a refused upgrade, or no answer in time.
 */
export function dialAppSocket(
  url: URL,
  protocols: readonly string[],
  dialMs = DIAL_MS,
): Promise<AppSocketLink | null> {
  return new Promise((resolve) => {
    let upstream: WebSocket;
    try {
      upstream = loopbackSocket('attached-app', url, protocols);
    } catch {
      resolve(null);
      return;
    }
    upstream.binaryType = 'arraybuffer';
    const timer = setTimeout(() => upstream.close(), dialMs);
    upstream.onopen = () => {
      clearTimeout(timer);
      resolve(new AppSocketLink(upstream));
    };
    // A failed handshake closes as well, and `resolve` takes the first answer.
    upstream.onclose = () => {
      clearTimeout(timer);
      resolve(null);
    };
  });
}
