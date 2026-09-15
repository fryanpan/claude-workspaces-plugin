import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../src/ws-client.ts';

/**
 * `reconnect()` opens a socket now instead of at the end of the backoff, for
 * a widget that just got the token a refused socket lacked. It must open one
 * socket, not two: the backoff's own timer is cancelled rather than left to
 * open a second behind it.
 */
const opened: StubWebSocket[] = [];

class StubWebSocket {
  static readonly OPEN = 1;
  readonly CONNECTING = 0;
  binaryType = 'blob';
  readyState = 0;
  listeners = new Map<string, (() => void)[]>();
  constructor(
    public url: string,
    public protocol?: string,
  ) {
    opened.push(this);
  }
  addEventListener(type: string, cb: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  removeEventListener(): void {}
  send(): void {}
  close(): void {}
  fire(type: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
}

let originalWebSocket: unknown;
beforeEach(() => {
  opened.length = 0;
  vi.useFakeTimers();
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = StubWebSocket;
});
afterEach(() => {
  vi.useRealTimers();
  (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
});

describe('connect().reconnect()', () => {
  it('opens one socket at once after a refusal, with the protocol as it is now', () => {
    const auth: { token?: string } = {};
    const client = connect('ws://localhost:0/y/test', () => auth.token);
    opened[0]?.fire('close');
    expect(client.status).toBe('closed');
    auth.token = 'wt2.token';
    client.reconnect();
    expect(opened).toHaveLength(2);
    expect(opened[1]?.protocol).toBe('wt2.token');
    // The backoff that the refusal scheduled does not open a third.
    vi.advanceTimersByTime(20_000);
    expect(opened).toHaveLength(2);
    client.close();
  });

  it('does nothing while a socket is connecting or open, or after close', () => {
    const client = connect('ws://localhost:0/y/test');
    client.reconnect();
    expect(opened, 'connecting').toHaveLength(1);
    opened[0]?.fire('open');
    client.reconnect();
    expect(opened, 'open').toHaveLength(1);
    client.close();
    client.reconnect();
    expect(opened, 'closed by its owner').toHaveLength(1);
  });

  it('CONTROL: without it, the refused socket is retried only by the backoff', () => {
    connect('ws://localhost:0/y/test');
    opened[0]?.fire('close');
    expect(opened).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(opened).toHaveLength(2);
  });
});
