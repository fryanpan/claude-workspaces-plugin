/**
 * Whether the doc's socket in a framed mock or app still carries bytes.
 *
 * A socket can go quiet with nothing telling the browser, as when a tablet
 * sleeps or a network changes. It stays `open`, so the widget in the frame
 * waits on it for good and the page stops being live until a reload. A frame
 * rarely sends anything, so the browser never finds out for itself.
 *
 * The host page asks: every {@link PROBE_EVERY_MS}, and at once when the page
 * wakes, it sends the probe frame (`core/src/ws-probe.ts`). Any frame from the
 * server inside {@link PROBE_ANSWER_MS} counts as an answer. No answer means
 * the socket is lost, and the frame's widget reconnects and syncs what it
 * missed. A false alarm, from a server busy for longer than that, costs one
 * reconnect.
 *
 * This lives in the host page, not in `ws-client.ts`, because the widget bundle
 * has no bytes to spare and this asset is outside its budget. A page that is
 * not framed has no such watch.
 */
import { MSG_PROBE } from '@claude-workspaces/core/ws-probe';

export const PROBE_EVERY_MS = 20_000;
export const PROBE_ANSWER_MS = 5_000;

const PROBE = new Uint8Array([MSG_PROBE]);

/** Whether a frame from the server is a probe's answer, which is the host's
 *  own and does not go on to the frame. */
export function isProbeAnswer(data: unknown): boolean {
  if (!(data instanceof ArrayBuffer) || data.byteLength !== 1) return false;
  return new Uint8Array(data)[0] === MSG_PROBE;
}

export interface WatchedSocket {
  /** The socket opened: begin the regular probes. */
  start(): void;
  /** Probe now, unless a probe is already waiting. */
  probe(): void;
  /** The server sent a frame. */
  heard(): void;
  stop(): void;
}

export function watchSocket(on: {
  send: (frame: Uint8Array) => void;
  lost: () => void;
}): WatchedSocket {
  let every: ReturnType<typeof setInterval> | undefined;
  let waiting: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    clearInterval(every);
    clearTimeout(waiting);
    waiting = undefined;
  };
  const probe = (): void => {
    if (waiting !== undefined) return;
    waiting = setTimeout(() => {
      stop();
      on.lost();
    }, PROBE_ANSWER_MS);
    on.send(PROBE);
  };
  return {
    start() {
      every = setInterval(probe, PROBE_EVERY_MS);
    },
    probe,
    heard() {
      clearTimeout(waiting);
      waiting = undefined;
    },
    stop,
  };
}
