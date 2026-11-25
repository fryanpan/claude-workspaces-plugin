/**
 * `doc-access.ts`: reading the socket's access frame, and deciding when the
 * page holds edits the server refused. The end-to-end proof, with a real
 * server and browser, is `doc-role-lock-browser.test.ts`; these cases pin the
 * decision table it rests on.
 */
import type { ConnectionStatus, FeedbackClient } from '@claude-workspaces/core';
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
  MSG_ACCESS,
  accessOfFrame,
  roleLabel,
  trackDocAccess,
  typingAllowed,
} from '../src/doc-access.ts';

const accessFrame = (body: unknown): Uint8Array => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_ACCESS);
  encoding.writeVarString(enc, JSON.stringify(body));
  return encoding.toUint8Array(enc);
};

const stepOne = (doc: Y.Doc): Uint8Array => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep1(enc, doc);
  return encoding.toUint8Array(enc);
};

/** A client whose socket the test opens, feeds and closes by hand. */
function fakeClient() {
  const ydoc = new Y.Doc();
  let ws = new EventTarget();
  const statusCbs: Array<(s: ConnectionStatus) => void> = [];
  const client = {
    ydoc,
    get ws() {
      return ws as unknown as WebSocket;
    },
    onStatus(cb: (s: ConnectionStatus) => void) {
      statusCbs.push(cb);
      cb('connecting');
    },
  } as unknown as FeedbackClient;
  return {
    client,
    ydoc,
    open() {
      ws = new EventTarget();
      for (const cb of statusCbs) cb('open');
    },
    close() {
      for (const cb of statusCbs) cb('closed');
    },
    receive(frame: Uint8Array) {
      const ev = new MessageEvent('message', { data: frame.slice().buffer });
      ws.dispatchEvent(ev);
    },
  };
}

const typeLocally = (doc: Y.Doc, text: string): void => {
  // A transaction with no origin is local, as an editor's keystroke is.
  doc.transact(() => doc.getText('t').insert(0, text));
};

describe('the access frame', () => {
  it('reads the role and mode, and nothing from any other frame', () => {
    expect(accessOfFrame(accessFrame({ role: 'view', mode: 'enforce' }))).toEqual({
      role: 'view',
      mode: 'enforce',
    });
    expect(accessOfFrame(accessFrame({ role: 'comment', mode: 'report-only' }))).toEqual({
      role: 'comment',
      mode: 'report-only',
    });
    expect(accessOfFrame(accessFrame({ role: 'admin' }))).toBeNull();
    expect(accessOfFrame(stepOne(new Y.Doc()))).toBeNull();
  });

  it('locks view and comment under enforce only, and labels them', () => {
    expect(typingAllowed(null)).toBe(true);
    expect(typingAllowed({ role: 'edit', mode: 'enforce' })).toBe(true);
    expect(typingAllowed({ role: 'view', mode: 'report-only' })).toBe(true);
    expect(roleLabel({ role: 'view', mode: 'enforce' })).toBe('View only');
    expect(roleLabel({ role: 'comment', mode: 'enforce' })).toBe('Comment only');
    expect(roleLabel({ role: 'owner', mode: 'enforce' })).toBeNull();
  });
});

describe('refused edits', () => {
  it('a view frame after typing while closed drops the doc; an edit frame does not', () => {
    for (const role of ['view', 'edit'] as const) {
      const c = fakeClient();
      let refused = 0;
      trackDocAccess(c.client, () => refused++);
      typeLocally(c.ydoc, 'Harborlight');
      c.open();
      c.receive(accessFrame({ role, mode: 'enforce' }));
      expect(refused, role).toBe(role === 'view' ? 1 : 0);
    }
  });

  it('a view frame with nothing typed keeps the doc and tells the surface', () => {
    const c = fakeClient();
    let refused = 0;
    const tracker = trackDocAccess(c.client, () => refused++);
    const told: string[] = [];
    tracker.onChange((a) => told.push(a.role));
    c.open();
    c.receive(stepOne(c.ydoc));
    c.receive(accessFrame({ role: 'view', mode: 'enforce' }));
    expect(refused).toBe(0);
    expect(told).toEqual(['view']);
    expect(tracker.current()).toEqual({ role: 'view', mode: 'enforce' });
  });

  it('a seeded doc ahead of the server is dropped on a view frame', () => {
    const c = fakeClient();
    let refused = 0;
    trackDocAccess(c.client, () => refused++);
    // Applied from elsewhere (a local copy), not typed on this page.
    const copy = new Y.Doc();
    copy.getText('t').insert(0, 'Riverbend');
    Y.applyUpdate(c.ydoc, Y.encodeStateAsUpdate(copy), 'doc-cache');
    c.open();
    c.receive(stepOne(new Y.Doc()));
    c.receive(accessFrame({ role: 'view', mode: 'enforce' }));
    expect(refused).toBe(1);
  });

  it('typing while an editor is open and told is kept across a later view frame', () => {
    const c = fakeClient();
    let refused = 0;
    trackDocAccess(c.client, () => refused++);
    c.open();
    c.receive(accessFrame({ role: 'edit', mode: 'enforce' }));
    typeLocally(c.ydoc, 'Saltmarsh');
    // The server took it: its next step 1 covers it.
    c.close();
    c.open();
    c.receive(stepOne(c.ydoc));
    c.receive(accessFrame({ role: 'view', mode: 'enforce' }));
    expect(refused).toBe(0);
  });
});
