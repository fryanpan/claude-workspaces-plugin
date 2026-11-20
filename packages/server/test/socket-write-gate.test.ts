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
import { summarise } from '../../../scripts/roles-would-refuse.ts';
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

  it('cannot place a delete that runs past what the doc holds', () => {
    // Yjs keeps the uncovered part pending and applies it to whatever lands
    // at those clocks later, a comment the server writes included.
    const server = new Y.Doc();
    server.getText('content').insert(0, 'hello');
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0); // no structs
    encoding.writeVarUint(enc, 1); // one client in the delete set
    encoding.writeVarUint(enc, server.clientID);
    encoding.writeVarUint(enc, 1); // one range
    encoding.writeVarUint(enc, 4);
    encoding.writeVarUint(enc, 1000);
    expect(rootsTouched(server, encoding.toUint8Array(enc)).has(null)).toBe(true);
  });

  it('places every item of a long unmerged history, however it is chained', () => {
    // A low client id types at the front thousands of times (no item merges,
    // each names the previous as its right neighbour); a higher id then types
    // after the last. Yjs encodes the higher id first, so placing its item
    // walks the whole chain.
    const low = new Y.Doc();
    low.clientID = 1;
    for (let i = 0; i < 8000; i++) low.getText('content').insert(0, 'x');
    const high = new Y.Doc();
    high.clientID = 2;
    Y.applyUpdate(high, Y.encodeStateAsUpdate(low));
    high.getText('content').insert(1, 'y');
    expect([...rootsTouched(new Y.Doc(), Y.encodeStateAsUpdate(high))]).toEqual(['content']);
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

  it('passes a step 2 that only repeats deletes the doc already holds, from any role', () => {
    // Yjs sends a doc's WHOLE delete set in every step 2, whatever the state
    // vector it answers. Resolving a thread overwrites its status, which
    // deletes the old value under `threads`, so every page that reconnects
    // to such a doc re-sends that delete. It writes nothing.
    const { server, client } = pair();
    (server.getMap('threads').get('th-1') as Y.Map<unknown>).set('status', 'resolved');
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server, Y.encodeStateVector(client)));
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep2(enc, client, Y.encodeStateVector(server));
    const reply = encoding.toUint8Array(enc);
    for (const role of ['owner', 'edit', 'comment', 'view'] as const) {
      expect(judgeSocketWrite(server, access(role), reply)).toBeNull();
    }
    // A page that typed while away sends its text with that same delete set:
    // an edit socket's text edit, not a threads write.
    client.getText('content').insert(0, 'Saltmarsh: ');
    const enc2 = encoding.createEncoder();
    encoding.writeVarUint(enc2, 0);
    syncProtocol.writeSyncStep2(enc2, client, Y.encodeStateVector(server));
    expect(judgeSocketWrite(server, access('edit'), encoding.toUint8Array(enc2))).toBeNull();
    expect(judgeSocketWrite(server, access('view'), encoding.toUint8Array(enc2))).toBe('role');
  });

  it('still refuses a delete under threads the doc has not made, beside one it has', () => {
    const { server, client } = pair();
    const thread = server.getMap('threads').get('th-1') as Y.Map<unknown>;
    thread.set('status', 'resolved');
    thread.set('author', 'Alice');
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server, Y.encodeStateVector(client)));
    // The client deletes the live author: its update's delete set names that
    // item alongside nothing else, and a step 2 names it beside the old status.
    const del = diff(client, (d) =>
      (d.getMap('threads').get('th-1') as Y.Map<unknown>).delete('author'),
    );
    expect(judgeSocketWrite(server, access('owner'), frame(del))).toBe('threads');
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep2(enc, client, Y.encodeStateVector(server));
    expect(judgeSocketWrite(server, access('owner'), encoding.toUint8Array(enc))).toBe('threads');
    expect(judgeSocketWrite(server, access('view'), encoding.toUint8Array(enc))).toBe('role');
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

  it('writes lines scripts/roles-would-refuse.ts counts, per board, role and reason', () => {
    const { server, client } = pair();
    const text = frame(diff(client, (d) => d.getText('content').insert(0, 'Alice: ')));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      refuseSocketWrite({}, 'd-1', server, access('comment', 'report-only'), text);
      refuseSocketWrite({}, 'd-2', server, access('comment', 'report-only'), text);
      refuseSocketWrite({}, 'd-1', server, access('view', 'enforce'), text);
      const lines = warn.mock.calls.map((args) => String(args[0]));
      expect(summarise([lines]).rows).toEqual([
        {
          board: 'ws-harborlight',
          role: 'comment',
          operation: 'role',
          count: 2,
          unplaced: 0,
          docs: 2,
        },
      ]);
      expect(summarise([lines], { verdict: 'refused' }).rows).toMatchObject([
        { board: 'ws-harborlight', role: 'view', operation: 'role', count: 1 },
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
