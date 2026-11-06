/**
 * The connection to an app's dev server, on its own: what it holds for a
 * reader whose socket has not opened, and which close codes may cross.
 */
import { describe, expect, it } from 'bun:test';
import { type AppSocketClient, AppSocketLink, relayableCloseCode } from '../src/app-socket-link.ts';

/** A dev server's end, driven by hand. */
function upstreamStandIn() {
  const closed: Array<[number | undefined, string | undefined]> = [];
  const sent: unknown[] = [];
  const up = {
    protocol: 'vite-hmr',
    readyState: 1,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    onclose: null as ((ev: { code: number; reason: string }) => void) | null,
    send: (data: unknown) => sent.push(data),
    close: (code?: number, reason?: string) => closed.push([code, reason]),
  };
  return { up, closed, sent, link: new AppSocketLink(up as unknown as WebSocket) };
}

function clientStandIn(answer = 1) {
  const frames: unknown[] = [];
  const closed: Array<[number | undefined, string | undefined]> = [];
  const client: AppSocketClient = {
    send: (data) => {
      frames.push(data);
      return answer;
    },
    close: (code, reason) => closed.push([code, reason]),
  };
  return { client, frames, closed };
}

describe('relayableCloseCode', () => {
  it('keeps every code a peer may send', () => {
    for (const code of [1000, 1001, 1002, 1003, 1007, 1011, 1014, 3000, 4100, 4999]) {
      expect(relayableCloseCode(code)).toBe(code);
    }
  });
  it('turns a code that only reports what a peer saw into a going-away', () => {
    for (const code of [0, 999, 1004, 1005, 1006, 1015, 2000, 5000]) {
      expect(relayableCloseCode(code)).toBe(1001);
    }
  });
});

describe('AppSocketLink', () => {
  it('holds what the dev server says before the reader opened, in order', () => {
    const { up, link } = upstreamStandIn();
    up.onmessage?.({ data: 'first' });
    up.onmessage?.({ data: 'second' });
    const reader = clientStandIn();
    link.attach(reader.client);
    up.onmessage?.({ data: 'third' });
    expect(reader.frames).toEqual(['first', 'second', 'third']);
  });

  it('closes a reader who opened after the dev server had gone', () => {
    const { up, link } = upstreamStandIn();
    up.onmessage?.({ data: 'connected' });
    up.onclose?.({ code: 1006, reason: '' });
    const reader = clientStandIn();
    link.attach(reader.client);
    expect(reader.frames).toEqual(['connected']);
    expect(reader.closed).toEqual([[1001, '']]);
  });

  it('gives up on a dev server that writes past the limit into no socket', () => {
    const { up, closed, link } = upstreamStandIn();
    up.onmessage?.({ data: 'x'.repeat(1024 * 1024 + 1) });
    expect(closed).toEqual([[1009, 'held frames over limit']]);
    const reader = clientStandIn();
    link.attach(reader.client);
    expect(reader.frames).toEqual([]);
  });

  it('closes a reader who has stopped keeping up, rather than leave a gap', () => {
    const { up, link } = upstreamStandIn();
    const reader = clientStandIn(0);
    link.attach(reader.client);
    up.onmessage?.({ data: 'dropped' });
    expect(reader.closed).toEqual([[1013, 'reader fell behind']]);
  });

  it('sends nothing once the dev server has gone', () => {
    const { up, sent, link } = upstreamStandIn();
    up.readyState = 3;
    link.fromClient('late');
    expect(sent).toEqual([]);
  });

  it('closes the dev server plainly when a client refuses the code', () => {
    const { up, link } = upstreamStandIn();
    const calls: Array<number | undefined> = [];
    up.close = (code) => {
      if (code !== undefined) throw new Error('refused');
      return calls.push(code);
    };
    link.clientClosed(1006, '');
    expect(calls).toEqual([undefined]);
  });
});
