/**
 * A whiteboard end to end: created on a board, drawn on from two open pages
 * and by an agent's verbs, heard by a watcher as one event per settled
 * burst, and still there after a restart.
 *
 * A real server and real `/y` sockets speaking the Yjs protocol the page
 * speaks; each page announces its person in presence as the page does.
 * Waits poll the observable or derive from the scaled `whiteboardSettleMs`.
 * Port 0, temp data dir, invented names.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_POINTERS_FIELD,
  type SceneElement,
  allSceneElements,
  parseAgentPointers,
  putSceneElements,
} from '@claude-workspaces/core/whiteboard-scene';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type FrameListener, listenFrames, waitForFrames } from './sse-frames.ts';
import { insideWhiteboardSettle, pastWhiteboardSettle, waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const AGENT = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent', color: '#2e7dd7' };

/** A page's side of the socket: sync, its own edits sent on, presence. */
function connectPage(url: string, origin: string, name: string) {
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  const ws = new WebSocket(url, { headers: { origin } } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let synced: () => void = () => {};
  const ready = new Promise<void>((r) => {
    synced = r;
  });
  const sendAwareness = () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [ydoc.clientID]),
    );
    ws.send(encoding.toUint8Array(enc));
  };
  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
    awareness.setLocalStateField('user', { name, color: '#c0392b' });
    sendAwareness();
  });
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    const kind = decoding.readVarUint(dec);
    if (kind === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
      return;
    }
    if (kind !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (type === syncProtocol.messageYjsSyncStep2) synced();
  });
  ydoc.on('update', (update: Uint8Array, from: unknown) => {
    if (from === ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  return { ydoc, awareness, ready, close: () => ws.close() };
}

const stroke = (id: string): SceneElement => ({
  id,
  type: 'freedraw',
  x: 10,
  y: 10,
  width: 40,
  height: 20,
  points: [
    [0, 0],
    [40, 20],
  ],
  version: 1,
  versionNonce: 7,
  index: `a${id}`,
});

describe('a whiteboard', () => {
  let handle: ServerHandle | null = null;
  let dataDir = '';
  const closers: Array<{ close: () => void }> = [];
  const streams: FrameListener[] = [];

  afterEach(async () => {
    for (const s of streams.splice(0)) await s.stop();
    for (const c of closers.splice(0)) c.close();
    await handle?.stop();
    handle = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is created on a board, drawn on by people and an agent, and outlives a restart', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-whiteboard-'));
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    let base = `http://127.0.0.1:${handle.port}`;
    const ws = await seedBoard(base);
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Created on the board: the server names it, and it opens at its own page.
    const created = await post(`/workspaces/${ws}/whiteboards`, { title: 'Harbour flow' });
    expect(created.status).toBe(200);
    const { docId, url, meta } = (await created.json()) as {
      docId: string;
      url: string;
      meta: { type: string; reviewUrl?: string };
    };
    expect(url).toBe(`/workspaces/${ws}/whiteboards/${docId}`);
    expect(meta.type).toBe('whiteboard');
    expect(meta.reviewUrl?.endsWith(url)).toBe(true);
    expect((await post(`/workspaces/${ws}/whiteboards`, { title: 7 })).status).toBe(400);
    const page = await fetch(`${base}${url}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Harbour flow');
    const asDoc = await fetch(`${base}/workspaces/${ws}/docs/${docId}`, { redirect: 'manual' });
    expect(asDoc.headers.get('location')).toStartWith(url);

    // A watcher on the doc's stream.
    const stream = await fetch(`${base}/workspaces/${ws}/docs/${docId}/events:stream`);
    const frames = listenFrames(stream);
    streams.push(frames);

    // Two pages open; a stroke on one appears on the other.
    const socketUrl = () => `ws://127.0.0.1:${handle?.port}/workspaces/${ws}/docs/${docId}/y`;
    const a = connectPage(socketUrl(), base, 'Riverbend');
    const b = connectPage(socketUrl(), base, 'Saltmarsh');
    closers.push(a, b);
    await Promise.all([a.ready, b.ready]);
    await waitFor(() => b.awareness.getStates().size >= 2, { describe: 'presence from page A' });
    putSceneElements(a.ydoc, [stroke('s1')], null);
    await waitFor(() => allSceneElements(b.ydoc).some((e) => e.id === 's1'), {
      describe: 'page A stroke on page B',
    });
    // timed: a second stroke inside the settle window joins the first's event.
    await new Promise((r) => setTimeout(r, insideWhiteboardSettle()));
    putSceneElements(a.ydoc, [stroke('s2')], null);

    // One event for both strokes, after the pen rests, naming the person.
    const [first] = await waitForFrames(frames.frames, 'whiteboard.changed', 1);
    expect(first?.data?.actor).toMatchObject({ name: 'Riverbend', kind: 'person' });
    expect(first?.data?.changed).toEqual(['s1', 's2']);
    expect(first?.data?.count).toBe(2);

    // The agent draws: a labelled box, an ellipse, an arrow joining them.
    const draw = (body: unknown) => post(`/workspaces/${ws}/docs/${docId}/whiteboard`, body);
    const added = await draw({
      author: AGENT,
      shapes: [
        { id: 'dock', kind: 'box', x: 0, y: 200, text: 'Dock' },
        { id: 'quay', kind: 'ellipse', x: 400, y: 200 },
        { id: 'route', kind: 'arrow', x: 0, y: 0, from: 'dock', to: 'quay' },
      ],
      point: { x: 420, y: 230 },
    });
    expect(added.status).toBe(200);
    const addedBody = (await added.json()) as { written: string[]; count: number };
    expect(addedBody.written).toEqual(
      expect.arrayContaining(['dock', 'dock-label', 'quay', 'route']),
    );
    await waitFor(() => allSceneElements(b.ydoc).some((e) => e.id === 'route'), {
      describe: 'the agent drawing on page B',
    });
    // The agent appears where it points, and only there.
    await waitFor(
      () =>
        [...b.awareness.getStates().values()].some(
          (s) => parseAgentPointers(s[AGENT_POINTERS_FIELD]).get(AGENT.id)?.x === 420,
        ),
      { describe: 'the agent pointer on page B' },
    );
    const agentFrame = (await waitForFrames(frames.frames, 'whiteboard.changed', 2))[1];
    expect(agentFrame?.data?.actor).toEqual({ id: AGENT.id, name: AGENT.name, kind: 'agent' });

    const read = async () =>
      (await (await fetch(`${base}/workspaces/${ws}/docs/${docId}/whiteboard`)).json()) as {
        shapes: Array<{ id: string; kind: string; text?: string; x: number }>;
        count: number;
      };
    let scene = await read();
    expect(scene.shapes.find((s) => s.id === 'dock')).toMatchObject({ kind: 'box', text: 'Dock' });
    expect(scene.shapes.find((s) => s.id === 's1')?.kind).toBe('freedraw');

    // Replace one shape by id.
    await draw({
      author: AGENT,
      shapes: [{ id: 'dock', kind: 'box', x: 50, y: 200, text: 'Pier' }],
    });
    scene = await read();
    expect(scene.shapes.find((s) => s.id === 'dock')).toMatchObject({ x: 50, text: 'Pier' });

    // Replace the whole scene.
    await draw({
      author: AGENT,
      mode: 'replace',
      shapes: [{ id: 'only', kind: 'text', x: 0, y: 0, text: 'Harborlight' }],
    });
    scene = await read();
    expect(scene.shapes.map((s) => s.id)).toEqual(['only']);
    expect(scene.count).toBe(1);
    await waitFor(
      () =>
        allSceneElements(b.ydoc)
          .filter((e) => !e.isDeleted)
          .map((e) => e.id)
          .join() === 'only',
      { describe: 'the replaced scene on page B' },
    );

    // Bad input is refused, naming what was wrong.
    expect((await draw({ shapes: [{ kind: 'star', x: 0, y: 0 }] })).status).toBe(400);
    expect((await draw({ shapes: [], mode: 'merge' })).status).toBe(400);
    expect((await draw({ shapes: [], point: { x: 'a' } })).status).toBe(400);

    // A restart keeps the drawing.
    for (const s of streams.splice(0)) await s.stop();
    for (const c of closers.splice(0)) c.close();
    await handle.stop();
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    base = `http://127.0.0.1:${handle.port}`;
    scene = await read();
    expect(scene.shapes).toEqual([
      expect.objectContaining({ id: 'only', kind: 'text', x: 0, y: 0, text: 'Harborlight' }),
    ]);
    const c = connectPage(socketUrl(), base, 'Riverbend');
    closers.push(c);
    await c.ready;
    expect(
      allSceneElements(c.ydoc)
        .filter((e) => !e.isDeleted)
        .map((e) => e.id),
    ).toEqual(['only']);
  }, 60_000);

  it('sends no event for a burst that is still going', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-whiteboard-quiet-'));
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://127.0.0.1:${handle.port}`;
    const ws = await seedBoard(base);
    const created = await fetch(`${base}/workspaces/${ws}/whiteboards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const { docId } = (await created.json()) as { docId: string };
    const frames = listenFrames(
      await fetch(`${base}/workspaces/${ws}/docs/${docId}/events:stream`),
    );
    streams.push(frames);
    const a = connectPage(
      `ws://127.0.0.1:${handle.port}/workspaces/${ws}/docs/${docId}/y`,
      base,
      'Riverbend',
    );
    closers.push(a);
    await a.ready;
    // Strokes keep landing inside the window, so it never closes.
    for (let i = 0; i < 4; i++) {
      putSceneElements(a.ydoc, [stroke(`k${i}`)], null);
      // timed: each stroke lands before the previous one's window closes.
      await new Promise((r) => setTimeout(r, insideWhiteboardSettle()));
    }
    expect(frames.frames.filter((f) => f.event === 'whiteboard.changed')).toEqual([]);
    // Then the pen rests, and exactly one event names all four.
    await waitForFrames(frames.frames, 'whiteboard.changed', 1);
    // timed: room for a duplicate to arrive, if there were one.
    await new Promise((r) => setTimeout(r, pastWhiteboardSettle()));
    const got = frames.frames.filter((f) => f.event === 'whiteboard.changed');
    expect(got.length).toBe(1);
    expect(got[0]?.data?.changed).toEqual(['k0', 'k1', 'k2', 'k3']);
  }, 60_000);
});
