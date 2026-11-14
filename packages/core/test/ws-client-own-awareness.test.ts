import * as decoding from 'lib0/decoding';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { connect } from '../src/ws-client.ts';

/**
 * On (re)connect a page announces its OWN presence and nobody else's. It used
 * to re-send every state it had heard, peers included, and the server treats
 * an entry for a client id another socket holds as foreign and drops it — so
 * those frames were wasted at best, and a peer's stale state at worst.
 */
const opened: StubWebSocket[] = [];

class StubWebSocket {
  static readonly OPEN = 1;
  readonly CONNECTING = 0;
  binaryType = 'blob';
  readyState = 0;
  sent: Uint8Array[] = [];
  listeners = new Map<string, ((ev?: unknown) => void)[]>();
  constructor(public url: string) {
    opened.push(this);
  }
  addEventListener(type: string, cb: (ev?: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  removeEventListener(): void {}
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {}
  fire(type: string, ev?: unknown): void {
    if (type === 'open') this.readyState = 1;
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
}

/** The client ids an awareness frame carries. */
function clientIdsIn(frame: Uint8Array): number[] | null {
  const dec = decoding.createDecoder(frame);
  if (decoding.readVarUint(dec) !== 1) return null;
  const inner = decoding.createDecoder(decoding.readVarUint8Array(dec));
  const n = decoding.readVarUint(inner);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(decoding.readVarUint(inner));
    decoding.readVarUint(inner);
    decoding.readVarString(inner);
  }
  return ids;
}

let originalWebSocket: unknown;
beforeEach(() => {
  opened.length = 0;
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = StubWebSocket;
});
afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
});

describe('the presence a page sends when its socket opens', () => {
  it("carries only the page's own client id, not the peers it heard", () => {
    const client = connect('ws://localhost:0/y/test');
    client.awareness.setLocalStateField('user', { id: 'anon-riverbend', name: 'Alice' });
    // A peer the page heard on an earlier socket.
    const peer = new Awareness(new Y.Doc());
    peer.setLocalState({ user: { id: 'anon-saltmarsh', name: 'Bob' } });
    applyAwarenessUpdate(client.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'remote');
    expect(client.awareness.getStates().size).toBe(2);

    opened[0]?.fire('open');
    const frames = (opened[0]?.sent ?? []).map(clientIdsIn).filter((x) => x !== null);
    expect(frames).toEqual([[client.ydoc.clientID]]);
    client.close();
    peer.destroy();
  });

  it('sends nothing when the page holds no presence of its own', () => {
    const client = connect('ws://localhost:0/y/test');
    client.awareness.setLocalState(null);
    opened[0]?.fire('open');
    const frames = (opened[0]?.sent ?? []).map(clientIdsIn).filter((x) => x !== null);
    expect(frames).toEqual([]);
    client.close();
  });
});
