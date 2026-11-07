/**
 * An agent's `replace` while a person has the whiteboard open. A real server
 * and a real `/y` socket: the tab holds moves it has not written yet, as
 * Excalidraw does during a drag, and writes them after the replace with the
 * version numbers a drag gave them. The board must end as the replace left it.
 * Port 0, temp data dir, invented names.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type SceneElement,
  allSceneElements,
  putSceneElements,
} from '@claude-workspaces/core/whiteboard-scene';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { drawShapes, keepWinningCopies, readScene } from '../src/whiteboard/scene.ts';
import { waitFor } from './wait-for.ts';
import { connectWhiteboardPage } from './whiteboard-page.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };

/** The copy a canvas holds after a drag of `steps` pointer moves. */
const dragged = (el: SceneElement, steps: number): SceneElement => ({
  ...el,
  x: Number(el.x) + 300,
  version: el.version + steps,
  versionNonce: el.versionNonce + 1,
});

describe('replacing a whiteboard a person has open', () => {
  let handle: ServerHandle | null = null;
  let dataDir = '';
  const closers: Array<{ close: () => void }> = [];

  afterEach(async () => {
    for (const c of closers.splice(0)) c.close();
    await handle?.stop();
    handle = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('ends in the replaced version after the tab writes its unsaved moves', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-whiteboard-race-'));
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://127.0.0.1:${handle.port}`;
    const ws = await seedBoard(base);
    const created = await fetch(`${base}/workspaces/${ws}/whiteboards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const { docId } = (await created.json()) as { docId: string };
    const draw = (body: unknown) =>
      fetch(`${base}/workspaces/${ws}/docs/${docId}/whiteboard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: AGENT, ...(body as object) }),
      });

    expect(
      (
        await draw({
          shapes: [
            { id: 'kept', kind: 'box', x: 0, y: 0, text: 'Riverbend' },
            { id: 'gone', kind: 'box', x: 200, y: 0, text: 'Saltmarsh' },
            { id: 'link', kind: 'arrow', x: 0, y: 0, from: 'kept', to: 'gone' },
          ],
        })
      ).status,
    ).toBe(200);

    const tab = connectWhiteboardPage(
      `ws://127.0.0.1:${handle.port}/workspaces/${ws}/docs/${docId}/y`,
      base,
      'Riverbend',
    );
    closers.push(tab);
    await tab.ready;

    // The person is dragging every column: the canvas has moved them, and
    // the page writes nothing until the gesture ends.
    const canvas = allSceneElements(tab.ydoc).map((e) => dragged(e, 40));
    expect(canvas).toHaveLength(5);

    const replaced = await draw({
      mode: 'replace',
      shapes: [
        { id: 'kept', kind: 'box', x: 10, y: 400, text: 'Harborlight' },
        { id: 'fresh', kind: 'text', x: 10, y: 600, text: 'Heading' },
      ],
    });
    expect(replaced.status).toBe(200);
    await waitFor(() => allSceneElements(tab.ydoc).some((e) => e.id === 'fresh'), {
      describe: 'the replace reaching the open tab',
    });

    // The gesture ends: the page writes every copy that beats the shared one.
    putSceneElements(tab.ydoc, canvas, { whiteboardPage: true });
    // Its write reaches the server, or is seen to be nothing to write: a
    // later page's view is the server's own.
    const later = connectWhiteboardPage(
      `ws://127.0.0.1:${handle.port}/workspaces/${ws}/docs/${docId}/y`,
      base,
      'Saltmarsh',
    );
    closers.push(later);
    await later.ready;
    await waitFor(() => JSON.stringify(view(later.ydoc)) === JSON.stringify(view(tab.ydoc)), {
      describe: 'the tab and a fresh page agreeing',
    });

    const res = await fetch(`${base}/workspaces/${ws}/docs/${docId}/whiteboard`);
    const scene = (await res.json()) as {
      shapes: Array<{ id: string; x: number; y: number; text?: string }>;
      count: number;
    };
    expect(scene.shapes.map((s) => s.id).sort()).toEqual(['fresh', 'kept']);
    expect(scene.shapes.find((s) => s.id === 'kept')).toMatchObject({
      x: 10,
      y: 400,
      text: 'Harborlight',
    });
    expect(scene.count).toBe(3);
  }, 30_000);
});

describe('a tab that was offline for the replace', () => {
  const ACTOR = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' as const };

  /** Yjs picks between two concurrent writes by client id alone. */
  const clientOrders = [
    { name: 'the higher client id', server: 1, tab: 2 },
    { name: 'the lower client id', server: 2, tab: 1 },
  ];

  for (const { name, server: serverClient, tab: tabClient } of clientOrders) {
    it(`loses its stale moves on reconnect holding ${name}`, () => {
      const server = new Y.Doc();
      server.clientID = serverClient;
      keepWinningCopies(server);
      drawShapes(
        server,
        [
          { id: 'kept', kind: 'box', x: 0, y: 0, text: 'Riverbend' },
          { id: 'gone', kind: 'box', x: 200, y: 0, text: 'Saltmarsh' },
        ],
        'add',
        ACTOR,
      );
      const tab = new Y.Doc();
      tab.clientID = tabClient;
      Y.applyUpdate(tab, Y.encodeStateAsUpdate(server), 'socket');

      // The socket is down: the page saves to its own doc, and the server
      // replaces the board without hearing about it.
      putSceneElements(
        tab,
        allSceneElements(tab).map((e) => dragged(e, 40)),
        { whiteboardPage: true },
      );
      drawShapes(
        server,
        [{ id: 'kept', kind: 'box', x: 10, y: 400, text: 'Harborlight' }],
        'replace',
        ACTOR,
      );

      // The socket returns and the two sync.
      const tabUpdate = Y.encodeStateAsUpdate(tab, Y.encodeStateVector(server));
      const serverUpdate = Y.encodeStateAsUpdate(server, Y.encodeStateVector(tab));
      Y.applyUpdate(server, tabUpdate, 'socket');
      Y.applyUpdate(tab, serverUpdate, 'socket');
      Y.applyUpdate(tab, Y.encodeStateAsUpdate(server, Y.encodeStateVector(tab)), 'socket');

      for (const doc of [server, tab]) {
        const { shapes } = readScene(doc);
        expect(shapes.map((s) => s.id)).toEqual(['kept']);
        expect(shapes[0]).toMatchObject({ x: 10, y: 400, text: 'Harborlight' });
      }
    });
  }
});

describe('replacing a board with deleted shapes on it', () => {
  it('beats a stale tab copy of a shape a person deleted before the replace', () => {
    const ACTOR = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' as const };
    const ydoc = new Y.Doc();
    drawShapes(ydoc, [{ id: 'old', kind: 'text', x: 0, y: 0, text: 'Saltmarsh' }], 'add', ACTOR);
    const shape = allSceneElements(ydoc)[0] as SceneElement;
    const page = { whiteboardPage: true };
    putSceneElements(ydoc, [{ ...shape, version: shape.version + 1, isDeleted: true }], page);
    drawShapes(
      ydoc,
      [{ id: 'new', kind: 'text', x: 0, y: 0, text: 'Riverbend' }],
      'replace',
      ACTOR,
    );
    putSceneElements(ydoc, [dragged(shape, 40)], page);
    expect(readScene(ydoc).shapes.map((s) => s.id)).toEqual(['new']);
  });
});

const view = (ydoc: Parameters<typeof allSceneElements>[0]) =>
  allSceneElements(ydoc).map((e) => [e.id, e.version, e.versionNonce]);
