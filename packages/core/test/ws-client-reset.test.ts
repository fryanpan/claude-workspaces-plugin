/**
 * "Your state is dead — start over", delivered.
 *
 * The server sends this to a tab that was open across a board doc's rebuild
 * (its `board-sync-gate.ts` decides who). Refusing that tab's history is only
 * half the fix: the tab still HOLDS its pre-restart structs, and they are
 * concurrent with the rebuild's, which a Yjs map resolves by clientID
 * magnitude — a coin flip per row. So a tab that is refused and not told
 * would show its pre-restart values for about half its rows, forever. This is
 * the half that tells it.
 */
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { connect } from '../src/ws-client.ts';

/** Kinds on the wire: 0 sync, 1 awareness, 2 reset. */
const MSG_RESET = 2;

/** A socket a test can push frames through. */
class DrivableWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  static last: DrivableWebSocket | null = null;
  binaryType = 'blob';
  readyState = 0;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();
  constructor(public url: string) {
    DrivableWebSocket.last = this;
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  /** Deliver one binary frame, the way a browser would. */
  deliver(bytes: Uint8Array): void {
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    for (const cb of this.listeners.get('message') ?? []) cb({ data: buf });
  }
}

/** A real awareness frame — a peer announcing itself. */
function awarenessFrame(): Uint8Array {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState({ name: 'a peer' });
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint8Array(
    enc,
    awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
  );
  const frame = encoding.toUint8Array(enc);
  awareness.destroy();
  doc.destroy();
  return frame;
}

let originalWebSocket: unknown;
beforeEach(() => {
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = DrivableWebSocket;
  DrivableWebSocket.last = null;
});
afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
});

describe('the reset message', () => {
  it('reaches a subscriber that was waiting for it', () => {
    const client = connect('ws://localhost:0/workspaces/w-1/y');
    let fired = 0;
    client.onReset(() => {
      fired++;
    });
    DrivableWebSocket.last?.deliver(new Uint8Array([MSG_RESET]));
    expect(fired).toBe(1);
    client.close();
  });

  it('reaches a subscriber that arrives after it', () => {
    // The board subscribes during boot, but a surface wired later must not
    // silently miss the one message that matters.
    const client = connect('ws://localhost:0/workspaces/w-1/y');
    DrivableWebSocket.last?.deliver(new Uint8Array([MSG_RESET]));
    let fired = 0;
    client.onReset(() => {
      fired++;
    });
    expect(fired).toBe(1);
    client.close();
  });

  it('fires once however many times it arrives', () => {
    // The surface's answer is to reload. Firing again while the page is on
    // its way out helps nobody, and a repeat reload is how a fix becomes a
    // loop.
    const client = connect('ws://localhost:0/workspaces/w-1/y');
    let fired = 0;
    client.onReset(() => {
      fired++;
    });
    DrivableWebSocket.last?.deliver(new Uint8Array([MSG_RESET]));
    DrivableWebSocket.last?.deliver(new Uint8Array([MSG_RESET]));
    expect(fired).toBe(1);
    client.close();
  });

  it('is not fired by any other kind on the wire', () => {
    // The control on the three above: an awareness frame is not a reset, and
    // neither is a kind this build has never heard of.
    const client = connect('ws://localhost:0/workspaces/w-1/y');
    let fired = 0;
    client.onReset(() => {
      fired++;
    });
    DrivableWebSocket.last?.deliver(awarenessFrame());
    DrivableWebSocket.last?.deliver(new Uint8Array([7]));
    expect(fired).toBe(0);
    client.close();
  });
});
