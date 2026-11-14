/**
 * `socket-write-gate.ts` on real Yjs updates: which root an update writes
 * under, including the items whose root is only reachable through the doc
 * (an edit inside an existing thread, an insert after existing text, a
 * delete), and what each role and mode does with the answer.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { AccessRole, RolesMode, SocketAccess } from '../src/share/board-access.ts';
import { judgeSocketWrite, refuseSocketWrite, rootsTouched } from '../src/socket-write-gate.ts';

/** A server doc holding one thread and some text, and a client synced to it. */
function pair(): { server: Y.Doc; client: Y.Doc } {
  const server = new Y.Doc();
  const thread = new Y.Map<unknown>();
  server.getMap('threads').set('th-1', thread);
  thread.set('status', 'open');
  server.getText('content').insert(0, 'Riverbend notes');
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  return { server, client };
}

/** The update `mutate` makes on the client, relative to what it held. */
function diff(client: Y.Doc, mutate: (d: Y.Doc) => void): Uint8Array {
  const before = Y.encodeStateVector(client);
  mutate(client);
  return Y.encodeStateAsUpdate(client, before);
}

function frame(update: Uint8Array, step: 'update' | 'step2' = 'update'): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  if (step === 'update') syncProtocol.writeUpdate(enc, update);
  else {
    encoding.writeVarUint(enc, syncProtocol.messageYjsSyncStep2);
    encoding.writeVarUint8Array(enc, update);
  }
  return encoding.toUint8Array(enc);
}

const access = (role: AccessRole, mode: RolesMode = 'enforce'): SocketAccess => ({
  role,
  workspaceId: 'ws-harborlight',
  mode: () => mode,
});

describe('rootsTouched', () => {
  it('places an insert after existing text under that text’s root', () => {
    const { server, client } = pair();
    const u = diff(client, (d) => d.getText('content').insert(5, ' and Saltmarsh'));
    expect([...rootsTouched(server, u)]).toEqual(['content']);
  });

  it('places an edit inside an existing thread under threads', () => {
    const { server, client } = pair();
    const u = diff(client, (d) => {
      (d.getMap('threads').get('th-1') as Y.Map<unknown>).set('status', 'resolved');
    });
    expect([...rootsTouched(server, u)]).toEqual(['threads']);
  });

  it('places a deleted thread under threads', () => {
    const { server, client } = pair();
    const u = diff(client, (d) => d.getMap('threads').delete('th-1'));
    expect(rootsTouched(server, u).has('threads')).toBe(true);
  });

  it('cannot place an item whose neighbour this doc never had', () => {
    const { client } = pair();
    const u = diff(client, (d) => d.getText('content').insert(3, 'x'));
    expect(rootsTouched(new Y.Doc(), u).has(null)).toBe(true);
  });
});

describe('judgeSocketWrite', () => {
  it('lets an edit socket change the text and refuses its write to threads', () => {
    const { server, client } = pair();
    const text = frame(diff(client, (d) => d.getText('content').insert(0, 'Alice: ')));
    expect(judgeSocketWrite(server, access('edit'), text)).toBeNull();
    const thread = frame(diff(client, (d) => d.getMap('threads').set('t-forged', new Y.Map())));
    expect(judgeSocketWrite(server, access('owner'), thread)).toBe('threads');
  });

  it('refuses any change from a comment or view socket, and never an empty step 2', () => {
    const { server, client } = pair();
    const text = frame(diff(client, (d) => d.getText('content').insert(0, 'Bob: ')));
    expect(judgeSocketWrite(server, access('comment'), text)).toBe('role');
    expect(judgeSocketWrite(server, access('view'), text)).toBe('role');
    const empty = frame(Y.encodeStateAsUpdate(client, Y.encodeStateVector(client)), 'step2');
    expect(judgeSocketWrite(server, access('view'), empty)).toBeNull();
  });

  it('never judges a sync step 1', () => {
    const { server, client } = pair();
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, client);
    expect(judgeSocketWrite(server, access('view'), encoding.toUint8Array(enc))).toBeNull();
  });
});

describe('refuseSocketWrite', () => {
  it('drops under enforce, applies under report-only, and logs once per socket', () => {
    const { server, client } = pair();
    const text = frame(diff(client, (d) => d.getText('content').insert(0, 'Bob: ')));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const socket = {};
      expect(refuseSocketWrite(socket, 'd-1', server, access('view', 'report-only'), text)).toBe(
        false,
      );
      expect(refuseSocketWrite(socket, 'd-1', server, access('view', 'report-only'), text)).toBe(
        false,
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(refuseSocketWrite({}, 'd-1', server, access('view', 'enforce'), text)).toBe(true);
      expect(String(warn.mock.calls[1]?.[0])).toMatch(/refused a role write on d-1/);
    } finally {
      warn.mockRestore();
    }
  });
});
