/**
 * `acceptSync`: a client seeded from a local copy may refuse a sync frame,
 * and a refused frame is neither applied nor answered.
 *
 * The copy records what the server held when it was written. A server whose
 * state vector no longer covers that has been rebuilt or restored, and the
 * copy's answer to its step 1 would hand back exactly what it shed
 * (workspaces-app doc-cache.ts, which decodes the frame and closes the client).
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { connect } from '../src/ws-client.ts';

const MSG_SYNC = 0;

class DrivableWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  static last: DrivableWebSocket | null = null;
  binaryType = 'blob';
  readyState = 1;
  sent: Uint8Array[] = [];
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
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  deliver(bytes: Uint8Array): void {
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    for (const cb of this.listeners.get('message') ?? []) cb({ data: buf });
  }
  /** The sync sub-kinds this socket has sent, in order. */
  syncKinds(): number[] {
    return this.sent.flatMap((frame) => {
      const dec = decoding.createDecoder(frame);
      return decoding.readVarUint(dec) === MSG_SYNC ? [decoding.readVarUint(dec)] : [];
    });
  }
}

/** The server opening a sync: step 1 carrying its state vector. */
function serverStep1(server: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, server);
  return encoding.toUint8Array(enc);
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

describe('acceptSync', () => {
  it('is asked with the whole frame', () => {
    const server = new Y.Doc();
    server.getText('t').insert(0, 'riverbend');
    const seen: Uint8Array[] = [];
    const client = connect('ws://localhost:0/d/y', undefined, (frame) => {
      seen.push(frame);
      return true;
    });
    const frame = serverStep1(server);
    DrivableWebSocket.last?.deliver(frame);
    expect(seen).toEqual([frame]);
    client.close();
  });

  it('accepted: the client answers with step 2, as without the check', () => {
    const client = connect('ws://localhost:0/d/y', undefined, () => true);
    DrivableWebSocket.last?.deliver(serverStep1(new Y.Doc()));
    expect(DrivableWebSocket.last?.syncKinds()).toContain(syncProtocol.messageYjsSyncStep2);
    client.close();
  });

  it('refused: the frame is not answered', () => {
    const client = connect('ws://localhost:0/d/y', undefined, () => false);
    client.ydoc.getText('t').insert(0, 'seeded from a copy');
    const sock = DrivableWebSocket.last as DrivableWebSocket;
    const before = sock.sent.length;
    sock.deliver(serverStep1(new Y.Doc()));
    expect(sock.sent.length).toBe(before);
    client.close();
  });

  it('refused: the frame is not applied', () => {
    const server = new Y.Doc();
    server.getText('t').insert(0, 'harborlight');
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(server));
    const refusing = connect('ws://localhost:0/d/y', undefined, () => false);
    DrivableWebSocket.last?.deliver(encoding.toUint8Array(enc));
    expect(refusing.ydoc.getText('t').toString()).toBe('');
    refusing.close();
    // The control: the same frame, accepted, lands.
    const accepting = connect('ws://localhost:0/d/y', undefined, () => true);
    DrivableWebSocket.last?.deliver(encoding.toUint8Array(enc));
    expect(accepting.ydoc.getText('t').toString()).toBe('harborlight');
    accepting.close();
  });
});
