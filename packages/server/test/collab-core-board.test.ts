/**
 * A board switched onto the collab core, end to end (D1 step 5).
 *
 * Real servers on port 0 over temp data folders, real board and doc sockets.
 * Each case names the done-when line it proves:
 *
 *   1. With the switch on for Harborlight, its board and a doc page sync edits
 *      between two pages, with the same frames a page gets from the current
 *      code.
 *   2. With the server-wide setting off, one restart returns every board to
 *      the current code, whatever the board's own setting says.
 *   3. An edit made with the switch on survives turning it off, and recorded
 *      traffic replayed through both paths gives the same doc.
 *   4. An edit followed at once by a restart survives on the core path.
 *
 * Which path served a socket is read from the core's own open rooms
 * (`handle.collabCore.path.openRooms()`), so a case cannot pass by both
 * boards quietly taking the current code.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  type Page,
  appendParagraph,
  openPage,
  proseText,
  recordTwoPages,
} from './collab-core-page.ts';
import { waitFor, waitForFile } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const dirs: string[] = [];
const handles: ServerHandle[] = [];
const pages: Page[] = [];

afterEach(async () => {
  for (const p of pages.splice(0)) p.close();
  for (const h of handles.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function boot(dataDir: string, collabCore: boolean): { handle: ServerHandle; base: string } {
  // Pages here prove nobody, so writes need the sign-in gate off.
  const handle = createServer({ port: 0, dataDir, collabCore, requireSignInToWrite: false });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}

/** Stop a server this file booted, and forget it. */
async function stop(handle: ServerHandle): Promise<void> {
  handles.splice(handles.indexOf(handle), 1);
  await handle.stop();
}

const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'collab-core-board-'));
  dirs.push(d);
  return d;
};

async function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function addDoc(base: string, dataDir: string, ws: string, docId: string): Promise<string> {
  const path = join(dataDir, `${docId}.md`);
  writeFileSync(path, `# ${docId}\n\nIntro paragraph.\n`);
  const r = await post(base, `/workspaces/${ws}/docs`, {
    docId,
    type: 'markdown',
    sourceUrl: path,
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { docId: string }).docId;
}

async function switchBoard(
  base: string,
  ws: string,
  on: boolean,
): Promise<{ on: boolean; active: boolean }> {
  const r = await post(base, `/workspaces/${ws}/collab-core`, { on });
  expect(r.status).toBe(200);
  return (await r.json()) as { on: boolean; active: boolean };
}

function page(base: string, path: string): Page {
  const p = openPage(`${base.replace('http', 'ws')}${path}`, base);
  pages.push(p);
  return p;
}

const boardPath = (ws: string) => `/workspaces/${ws}/y`;
const docPath = (ws: string, docId: string) => `/workspaces/${ws}/docs/${docId}/y`;
const taskTitles = (ydoc: Y.Doc): string[] =>
  [...ydoc.getMap('tasks').values()].map((t) => String((t as { title?: unknown }).title));

describe('done-when 1: a board switched on syncs its board and doc pages', () => {
  it('syncs the board between two pages, and a task filed on the server reaches both', async () => {
    const dataDir = freshDir();
    const { handle, base } = boot(dataDir, true);
    const ws = await seedBoard(base, { name: 'Harborlight' });
    expect(await switchBoard(base, ws, true)).toMatchObject({ on: true, active: true });
    const a = page(base, boardPath(ws));
    const b = page(base, boardPath(ws));
    await Promise.all([a.ready, b.ready]);
    expect(handle.collabCore.path.openRooms()).toEqual([`ws:${ws}`]);

    const r = await post(base, `/workspaces/${ws}/tasks`, {
      title: 'Harborlight first task',
      author: { id: 'known-person', name: 'Alice', kind: 'known', color: '#2e7dd7' },
    });
    expect(r.status).toBe(200);
    await waitFor(() => taskTitles(a.ydoc).includes('Harborlight first task'), {
      describe: 'task on page a',
    });
    await waitFor(() => taskTitles(b.ydoc).includes('Harborlight first task'), {
      describe: 'task on page b',
    });

    // A page's own edit reaches the other page through the core's room.
    a.ydoc.getMap('harborlight-scratch').set('note', 'from page a');
    await waitFor(() => b.ydoc.getMap('harborlight-scratch').get('note') === 'from page a', {
      describe: 'page a’s edit on page b',
    });
  });

  it('syncs a doc page between two pages, writes it to its file and names who typed it', async () => {
    const dataDir = freshDir();
    const { handle, base } = boot(dataDir, true);
    const ws = await seedBoard(base, { name: 'Harborlight' });
    const docId = await addDoc(base, dataDir, ws, 'harborlight-notes');
    await switchBoard(base, ws, true);
    const a = page(base, docPath(ws, docId));
    const b = page(base, docPath(ws, docId));
    await Promise.all([a.ready, b.ready]);
    expect(proseText(a.ydoc)).toContain('Intro paragraph.');
    expect(handle.collabCore.path.openRooms()).toEqual([docId]);
    // Still in the doc's connections, which the share sweeps and the
    // eviction hold read: a revoke reaches a core socket the same way.
    expect(handle.docStore.peek(docId)?.conns.size).toBe(2);

    appendParagraph(a.ydoc, 'Riverbend tide tables');
    await waitFor(() => proseText(b.ydoc).includes('Riverbend tide tables'), {
      describe: 'edit on page b',
    });
    await waitForFile(join(dataDir, 'harborlight-notes.md'), (t) =>
      t.includes('Riverbend tide tables'),
    );
    // The socket is the edit's origin, so the edit is attributed as before.
    await waitFor(() => handle.docStore.editSessions.openCount() > 0, {
      describe: 'an edit session',
    });
  });

  it('sends a page the same frames, in the same order, as the current code', async () => {
    const dataDir = freshDir();
    const { handle, base } = boot(dataDir, true);
    const harborlight = await seedBoard(base, { name: 'Harborlight' });
    const riverbend = await seedBoard(base, { name: 'Riverbend' });
    const onDoc = await addDoc(base, dataDir, harborlight, 'harborlight-notes');
    const offDoc = await addDoc(base, dataDir, riverbend, 'riverbend-notes');
    await switchBoard(base, harborlight, true);

    const core = page(base, docPath(harborlight, onDoc));
    const current = page(base, docPath(riverbend, offDoc));
    await Promise.all([core.ready, current.ready]);
    expect(handle.collabCore.path.openRooms()).toEqual([onDoc]);
    expect(core.kinds).toEqual(current.kinds);
    expect(core.kinds[0]).toBe('sync:0');
    expect(core.kinds).toContain('sync:1');

    const coreBoard = page(base, boardPath(harborlight));
    const currentBoard = page(base, boardPath(riverbend));
    await Promise.all([coreBoard.ready, currentBoard.ready]);
    expect(coreBoard.kinds).toEqual(currentBoard.kinds);
  });
});

describe('done-when 2: the server-wide setting off returns every board to the current code', () => {
  it('serves a switched-on board with the current code after one restart', async () => {
    const dataDir = freshDir();
    const first = boot(dataDir, true);
    const ws = await seedBoard(first.base, { name: 'Harborlight' });
    const docId = await addDoc(first.base, dataDir, ws, 'harborlight-notes');
    await switchBoard(first.base, ws, true);
    const before = page(first.base, docPath(ws, docId));
    await before.ready;
    // Positive control: the same board on the same data took the core path.
    expect(first.handle.collabCore.path.openRooms()).toEqual([docId]);
    before.close();
    await stop(first.handle);

    const second = boot(dataDir, false);
    expect(second.handle.collabCore.switch.boardOn(ws)).toBe(true);
    const a = page(second.base, docPath(ws, docId));
    const b = page(second.base, docPath(ws, docId));
    const board = page(second.base, boardPath(ws));
    await Promise.all([a.ready, b.ready, board.ready]);
    expect(second.handle.collabCore.path.openRooms()).toEqual([]);
    appendParagraph(a.ydoc, 'Saltmarsh survey');
    await waitFor(() => proseText(b.ydoc).includes('Saltmarsh survey'), {
      describe: 'edit on page b',
    });
    expect(second.handle.collabCore.path.openRooms()).toEqual([]);
  });
});

describe('done-when 3: switching off loses nothing, and both paths make the same doc', () => {
  it('keeps an edit made on the core path after the board is switched off, live and after a restart', async () => {
    const dataDir = freshDir();
    const first = boot(dataDir, true);
    const ws = await seedBoard(first.base, { name: 'Harborlight' });
    const docId = await addDoc(first.base, dataDir, ws, 'harborlight-notes');
    await switchBoard(first.base, ws, true);
    const editor = page(first.base, docPath(ws, docId));
    await editor.ready;
    expect(first.handle.collabCore.path.openRooms()).toEqual([docId]);
    appendParagraph(editor.ydoc, 'Made on the core path');
    await waitFor(() =>
      proseText(first.handle.docStore.peek(docId)?.ydoc ?? new Y.Doc()).includes(
        'Made on the core path',
      ),
    );
    editor.close();
    await waitFor(() => first.handle.collabCore.path.openRooms().length === 0, {
      describe: 'room let go',
    });

    expect(await switchBoard(first.base, ws, false)).toMatchObject({ on: false, active: false });
    const reader = page(first.base, docPath(ws, docId));
    await reader.ready;
    expect(first.handle.collabCore.path.openRooms()).toEqual([]);
    expect(proseText(reader.ydoc)).toContain('Made on the core path');
    reader.close();
    await stop(first.handle);

    const second = boot(dataDir, false);
    const after = page(second.base, docPath(ws, docId));
    await after.ready;
    expect(proseText(after.ydoc)).toContain('Made on the core path');
  });

  it('gives the same doc when recorded traffic is replayed through the core and the current code', async () => {
    const dataDir = freshDir();
    const { handle, base } = boot(dataDir, true);
    const harborlight = await seedBoard(base, { name: 'Harborlight' });
    const riverbend = await seedBoard(base, { name: 'Riverbend' });
    const onDoc = await addDoc(base, dataDir, harborlight, 'harborlight-replay');
    const offDoc = await addDoc(base, dataDir, riverbend, 'riverbend-replay');
    await switchBoard(base, harborlight, true);
    const recorded = recordTwoPages();

    const replay = async (ws: string, docId: string): Promise<Y.Doc> => {
      const pageA = openPage(`${base.replace('http', 'ws')}${docPath(ws, docId)}`, base, {
        quiet: true,
      });
      const pageB = openPage(`${base.replace('http', 'ws')}${docPath(ws, docId)}`, base, {
        quiet: true,
      });
      pages.push(pageA, pageB);
      await Promise.all([pageA.ready, pageB.ready]);
      const live = handle.docStore.peek(docId)?.ydoc;
      if (!live) throw new Error(`no live doc ${docId}`);
      // In the recorded order, each frame applied before the next is sent.
      for (const [i, { from, frame }] of recorded.entries()) {
        const before = Y.encodeStateVector(live);
        (from === 'a' ? pageA : pageB).sendRaw(frame);
        await waitFor(() => !equalBytes(Y.encodeStateVector(live), before), {
          describe: `recorded frame ${i} applied to ${docId}`,
        });
      }
      return live;
    };
    const viaCore = await replay(harborlight, onDoc);
    expect(handle.collabCore.path.openRooms()).toEqual([onDoc]);
    const viaCurrent = await replay(riverbend, offDoc);
    expect(handle.collabCore.path.openRooms()).toEqual([onDoc]);

    const expected = new Y.Doc();
    for (const { update } of recorded) Y.applyUpdate(expected, update);
    for (const doc of [viaCore, viaCurrent]) {
      expect(doc.getText('replay').toString()).toBe(expected.getText('replay').toString());
      expect(doc.getMap('replay-meta').toJSON()).toEqual({ author: 'Bob' });
      const sv = Y.decodeStateVector(Y.encodeStateVector(doc));
      expect([sv.get(101), sv.get(202)]).toEqual([
        Y.decodeStateVector(Y.encodeStateVector(expected)).get(101),
        Y.decodeStateVector(Y.encodeStateVector(expected)).get(202),
      ]);
    }
    expect(viaCore.getText('replay').toDelta()).toEqual(viaCurrent.getText('replay').toDelta());
  });
});

describe('done-when 4: an edit followed at once by a restart survives on the core path', () => {
  it('keeps the edit when the server stops the moment it has it', async () => {
    const dataDir = freshDir();
    const first = boot(dataDir, true);
    const ws = await seedBoard(first.base, { name: 'Harborlight' });
    const docId = await addDoc(first.base, dataDir, ws, 'harborlight-notes');
    await switchBoard(first.base, ws, true);
    const editor = page(first.base, docPath(ws, docId));
    await editor.ready;
    expect(first.handle.collabCore.path.openRooms()).toEqual([docId]);
    appendParagraph(editor.ydoc, 'Typed just before the restart');
    const live = first.handle.docStore.peek(docId)?.ydoc ?? new Y.Doc();
    await waitFor(() => proseText(live).includes('Typed just before the restart'), {
      describe: 'the server holds the edit',
    });
    // No wait for the save debounce: the restart follows the edit at once.
    await stop(first.handle);

    const second = boot(dataDir, true);
    const after = page(second.base, docPath(ws, docId));
    await after.ready;
    expect(second.handle.collabCore.path.openRooms()).toEqual([docId]);
    expect(proseText(after.ydoc)).toContain('Typed just before the restart');
  });
});

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
