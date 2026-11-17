/**
 * The host page's watch on the doc socket it relays for a frame: a socket that
 * stops carrying bytes is closed to the frame, and one that answers is left
 * alone. The two ends are joined as in `mock-bridge-host.test.ts`; the browser
 * case that a real page recovers is `app-resolve-cases.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROBE_ANSWER_MS, PROBE_EVERY_MS } from '../src/mock-host-liveness.ts';
import { HostSocket, build } from './mock-bridge-harness.ts';

const DOC_SOCKET = 'ws://harborlight.test/workspaces/w-harbor/docs/d-moorings/y';
const APP_SOCKET = 'ws://harborlight.test/workspaces/w-harbor/apps/d-moorings/y';

const probeAnswer = () => new Uint8Array([3]).buffer;
let h: ReturnType<typeof build>;
beforeEach(() => {
  h = build();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function opened(url: string) {
  const ws = new h.w.WebSocket(url);
  const events: string[] = [];
  ws.onmessage = () => events.push('message');
  ws.onclose = () => events.push('close');
  await vi.waitFor(() => expect(HostSocket.made).toHaveLength(1));
  const sock = HostSocket.made[0] as HostSocket;
  // Only the clock is faked: the ports between the two ends stay real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  sock.readyState = 1;
  sock.onopen?.();
  await vi.waitFor(() => expect(ws.readyState).toBe(1));
  return { ws, sock, events };
}

describe("the doc socket's watch", () => {
  it('closes a socket that does not answer to the frame at once, without waiting on the socket', async () => {
    const { ws, sock, events } = await opened(DOC_SOCKET);
    vi.advanceTimersByTime(PROBE_EVERY_MS);
    expect(sock.sent).toHaveLength(1);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(PROBE_ANSWER_MS);
    expect(sock.closed).toBe(1);
    await vi.waitFor(() => expect(events).toEqual(['close']));
    expect(ws.readyState).toBe(3);
  });

  it('leaves an answering socket open, and keeps the answer from the frame', async () => {
    const { ws, sock, events } = await opened(DOC_SOCKET);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(PROBE_EVERY_MS);
      sock.onmessage?.({ data: probeAnswer() });
    }
    vi.advanceTimersByTime(PROBE_ANSWER_MS);
    expect(sock.sent).toHaveLength(3);
    expect(sock.closed).toBe(0);
    sock.onmessage?.({ data: new ArrayBuffer(4) });
    await vi.waitFor(() => expect(events).toEqual(['message']));
    expect(ws.readyState).toBe(1);
  });

  it('counts any frame from the server as an answer', async () => {
    const { sock } = await opened(DOC_SOCKET);
    vi.advanceTimersByTime(PROBE_EVERY_MS);
    sock.onmessage?.({ data: new ArrayBuffer(4) });
    vi.advanceTimersByTime(PROBE_ANSWER_MS);
    expect(sock.closed).toBe(0);
  });

  it('probes at once when the page wakes, and once while waiting', async () => {
    const { sock } = await opened(DOC_SOCKET);
    h.wake();
    h.wake();
    expect(sock.sent).toHaveLength(1);
    vi.advanceTimersByTime(PROBE_ANSWER_MS);
    expect(sock.closed).toBe(1);
  });

  it('stops probing once the socket closes by itself', async () => {
    const { sock } = await opened(DOC_SOCKET);
    sock.onclose?.({ code: 1006, reason: '' });
    h.wake();
    vi.advanceTimersByTime(PROBE_EVERY_MS * 3);
    expect(sock.sent).toEqual([]);
  });

  it("never probes an app's own socket, which is the dev server's", async () => {
    const { sock } = await opened(APP_SOCKET);
    h.wake();
    vi.advanceTimersByTime(PROBE_EVERY_MS * 3);
    expect(sock.sent).toEqual([]);
    expect(sock.closed).toBe(0);
  });
});
