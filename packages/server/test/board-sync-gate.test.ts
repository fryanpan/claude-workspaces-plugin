/**
 * A tab that was open across a board doc's rebuild, and what the server does
 * with the 5 MB of history it offers.
 *
 * The compaction only pays for itself if it STAYS paid. Sync exchanges state
 * vectors and a rebuild mints entirely new clientIDs, so a reconnecting tab
 * is asked for everything and hands back the whole doc it was holding — which
 * the server merged, the projection re-deleted, and the tombstones kept.
 * Measured against a copy of the live board: 969,990 bytes back to 2,975,791
 * on the first restart with one such tab, and ~+18.7 KB on every restart
 * after that.
 *
 * What is driven here is the decision and the socket that acts on it. The
 * negative control is the point of the file: a doc that is NOT a board
 * projection, in the identical situation, still merges — because there a
 * client's offline edits are real work and dropping them is data loss.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { compactBoardState } from '../src/board-doc-compaction.ts';
import { clientStateIsDead, peekSyncFrame } from '../src/board-sync-gate.ts';
import type { FeedbackWs, LiveDoc } from '../src/doc-store.ts';
import { MSG_RESET, MSG_SYNC, onMessage } from '../src/yjs-protocol.ts';

const opened: Array<{ destroy: () => void }> = [];
afterEach(() => {
  while (opened.length > 0) opened.pop()?.destroy();
});

/** A board doc with a past — one transaction per row, which is what leaves a
 *  delete set worth shedding. */
function historicalBoard(): Uint8Array {
  const doc = new Y.Doc();
  const tasks = doc.getMap('tasks');
  for (let pass = 0; pass < 40; pass++) {
    for (let i = 0; i < 300; i++) {
      doc.transact(() => {
        tasks.set(`t-${i}`, { id: `t-${i}`, title: `row ${i}`, pass, blurb: 'x'.repeat(400) });
      });
    }
  }
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

function clientIdsOf(ydoc: Y.Doc): number[] {
  return [...Y.decodeStateVector(Y.encodeStateVector(ydoc)).keys()].sort();
}

/** The server's live doc, as it stands after a hydrate that rebuilt it. */
function serverDoc(docId: string, opts: { state: Uint8Array }): LiveDoc {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, opts.state);
  const awareness = new awarenessProtocol.Awareness(ydoc);
  opened.push({
    destroy: () => {
      awareness.destroy();
      ydoc.destroy();
    },
  });
  return {
    docId,
    ydoc,
    awareness,
    peekAwareness: () => awareness,
    conns: new Set<FeedbackWs>(),
  } as unknown as LiveDoc;
}

function socket(docId: string) {
  const sent: Uint8Array[] = [];
  const ws = {
    data: { docId, readOnly: false },
    sendBinary: (payload: Uint8Array) => {
      sent.push(payload.slice());
    },
  } as unknown as FeedbackWs;
  return { ws, sent };
}

/** The client's sync step 1 — "here is what I have, send me the rest". */
function step1(ydoc: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, ydoc);
  return encoding.toUint8Array(enc);
}

/** The client's sync step 2 — everything the server's vector says it lacks.
 *  On a rebuilt board doc that is the client's entire history. */
function step2(ydoc: Y.Doc, against: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep2(enc, ydoc, Y.encodeStateVector(against));
  return encoding.toUint8Array(enc);
}

function kindsOf(frames: Uint8Array[]): number[] {
  return frames.map((f) => decoding.readVarUint(decoding.createDecoder(f)));
}

/** The whole reconnect, as one call: the tab's step 1 then its step 2. */
function reconnect(doc: LiveDoc, client: Y.Doc): { sent: Uint8Array[] } {
  const { ws, sent } = socket(doc.docId);
  onMessage(doc, ws, step1(client));
  onMessage(doc, ws, step2(client, doc.ydoc));
  return { sent };
}

describe('a client whose state predates the rebuild', () => {
  const historical = historicalBoard();
  const rebuilt = compactBoardState(historical);

  /** The fixture's own control: if the rebuild kept the same clientIDs there
   *  would be no problem to solve and every test below would be vacuous. */
  it('is a real situation — the rebuild shares no clientID with the past', () => {
    expect(rebuilt.compacted).toBe(true);
    const before = new Y.Doc();
    Y.applyUpdate(before, historical);
    const after = new Y.Doc();
    Y.applyUpdate(after, rebuilt.update);
    const shared = clientIdsOf(after).filter((id) => clientIdsOf(before).includes(id));
    expect(shared).toEqual([]);
    before.destroy();
    after.destroy();
  });

  function staleTab(): Y.Doc {
    const client = new Y.Doc();
    Y.applyUpdate(client, historical);
    opened.push({ destroy: () => client.destroy() });
    return client;
  }

  it('is told to reset, and its history is not merged in', () => {
    const doc = serverDoc('ws:w-1', { state: rebuilt.update });
    const before = clientIdsOf(doc.ydoc);
    const { sent } = reconnect(doc, staleTab());

    expect(kindsOf(sent)).toContain(MSG_RESET);
    // Still answered: the tab gets current content while it reloads, rather
    // than a socket that goes quiet and trips its own sync watchdog.
    expect(kindsOf(sent)).toContain(MSG_SYNC);
    // And the 5 MB stayed where it was.
    expect(clientIdsOf(doc.ydoc)).toEqual(before);
  });

  it('is refused on a LATER boot too, when nothing was rebuilt this time', () => {
    // The hole the first shape of this gate left, and the reason it asks
    // about the vectors rather than about whether this boot rebuilt anything.
    // A tab that does not act on the reset — every tab running the bundle
    // that shipped before it, which is exactly the set open across the
    // deploy — keeps its stale doc, and the next boot finds a doc already
    // compact and nothing to rebuild. Measured on a copy of the live board:
    // 973,310 bytes held at boot, 2,983,799 on the restart after it.
    //
    // `alreadyCompact` is the same doc a second boot reads off disk: it went
    // through no rebuild in this process at all.
    const alreadyCompact = compactBoardState(rebuilt.update);
    expect(alreadyCompact.compacted).toBe(false);
    const doc = serverDoc('ws:w-1', { state: alreadyCompact.update });
    const before = clientIdsOf(doc.ydoc);
    const { sent } = reconnect(doc, staleTab());

    expect(kindsOf(sent)).toContain(MSG_RESET);
    expect(clientIdsOf(doc.ydoc)).toEqual(before);
  });

  it('is merged as before on a doc that is not a board projection', () => {
    // THE scoping test. A bound markdown doc rebuilt for any reason must
    // still take a client's offline work — the argument for dropping it holds
    // only where every row is reasserted from the task sidecar, which is true
    // of `ws:` docs and nothing else. Everything but the id is identical to
    // the refused case above.
    const doc = serverDoc('d-bound', { state: rebuilt.update });
    const before = clientIdsOf(doc.ydoc);
    const { sent } = reconnect(doc, staleTab());

    expect(kindsOf(sent)).not.toContain(MSG_RESET);
    expect(clientIdsOf(doc.ydoc).length).toBeGreaterThan(before.length);
  });

  it('leaves a fresh tab alone', () => {
    // An empty state vector is every ordinary first load, and it shares no
    // clientID with anything. Refusing it would refuse everybody — and would
    // turn the reload this sends into an endless loop, since a reloaded tab
    // comes back with exactly this.
    const doc = serverDoc('ws:w-1', { state: rebuilt.update });
    const fresh = new Y.Doc();
    opened.push({ destroy: () => fresh.destroy() });
    const { ws, sent } = socket(doc.docId);
    onMessage(doc, ws, step1(fresh));
    expect(kindsOf(sent)).not.toContain(MSG_RESET);
  });
});

describe('clientStateIsDead', () => {
  const vector = (ids: number[]): Uint8Array => {
    const doc = new Y.Doc();
    for (const id of ids) {
      doc.clientID = id;
      doc.getMap('tasks').set(`k-${id}`, id);
    }
    const sv = Y.encodeStateVector(doc);
    doc.destroy();
    return sv;
  };

  const base = { docId: 'ws:w-1' };

  it('says yes only when there is no overlap at all', () => {
    expect(
      clientStateIsDead({
        ...base,
        clientStateVector: vector([11, 12]),
        docStateVector: vector([21, 22]),
      }),
    ).toBe(true);
  });

  it('says no when a single clientID is shared', () => {
    // One shared id means some causal overlap, which means this is not the
    // case the gate exists for and merging is the safe reading.
    expect(
      clientStateIsDead({
        ...base,
        clientStateVector: vector([11, 21]),
        docStateVector: vector([21, 22]),
      }),
    ).toBe(false);
  });

  it('says no to an empty client vector', () => {
    expect(
      clientStateIsDead({ ...base, clientStateVector: vector([]), docStateVector: vector([21]) }),
    ).toBe(false);
  });

  for (const docId of ['task:t-1', 'd-bound', 'meeting-notes-2026-01-01']) {
    it(`says no on ${docId}, whatever the vectors say`, () => {
      expect(
        clientStateIsDead({
          ...base,
          docId,
          clientStateVector: vector([11]),
          docStateVector: vector([21]),
        }),
      ).toBe(false);
    });
  }

  it('says no rather than guessing when a vector will not decode', () => {
    expect(
      clientStateIsDead({
        ...base,
        clientStateVector: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
        docStateVector: vector([21]),
      }),
    ).toBe(false);
  });
});

describe('peekSyncFrame', () => {
  it('reads a step 1 and hands back its state vector', () => {
    const client = new Y.Doc();
    client.getMap('tasks').set('t-1', 1);
    const parsed = peekSyncFrame(step1(client));
    expect(parsed?.step).toBe(syncProtocol.messageYjsSyncStep1);
    expect(Y.decodeStateVector(parsed?.stateVector as Uint8Array).has(client.clientID)).toBe(true);
    client.destroy();
  });

  it('names a step 2 without pretending it carries a vector', () => {
    const client = new Y.Doc();
    client.getMap('tasks').set('t-1', 1);
    const parsed = peekSyncFrame(step2(client, new Y.Doc()));
    expect(parsed?.step).toBe(syncProtocol.messageYjsSyncStep2);
    expect(parsed?.stateVector).toBeNull();
    client.destroy();
  });

  it('has no opinion about a frame it cannot read', () => {
    expect(peekSyncFrame(new Uint8Array([]))).toBeNull();
  });
});
