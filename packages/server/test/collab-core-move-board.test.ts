/**
 * Moving a board onto the collab core and back while pages are open on it.
 *
 * The server boots with no `CW_COLLAB_CORE`, so the runtime server-wide
 * switch decides, as on a server whose launch environment nobody edits. The
 * move is the two calls the board's own switch makes through
 * `POST /workspaces/<id>/collab-core` (whose gate `collab-core-runtime-route
 * .test.ts` covers). A socket keeps the path it opened on, so each direction
 * is checked three ways: the pages already open keep working, a page opened
 * after the move takes the new path and syncs with the old ones, and pages
 * that reconnect all take the new path. Doc text, comments and presence must
 * survive each.
 *
 * Which path served a socket is read from the core's own open rooms, so a
 * case cannot pass by every socket quietly taking the current code.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type Page, appendParagraph, openPage, proseText } from './collab-core-page.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const dirs: string[] = [];
const handles: ServerHandle[] = [];
const pages: Page[] = [];

afterEach(async () => {
  for (const p of pages.splice(0)) p.close();
  for (const h of handles.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const threadIds = (ydoc: Y.Doc): string[] => [...ydoc.getMap('threads').keys()];
/** The server stamps each state's `user` with the socket's own person, so a
 *  page says which seat it is in a field of its own. */
const names = (p: Page): string[] =>
  [...p.awareness.getStates().values()]
    .map((s) => (s as { seat?: unknown }).seat)
    .filter((n): n is string => typeof n === 'string');
const sit = (p: Page, seat: string) => p.awareness.setLocalStateField('seat', seat);

describe('a board moved onto the collab core and back with pages open', () => {
  it('keeps doc text, comments and presence in both directions', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'collab-core-move-'));
    dirs.push(dataDir);
    // No `collabCore` option and no CW_COLLAB_CORE: the runtime switch decides.
    const handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    handles.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;
    const sw = handle.collabCore.switch;
    expect(sw.fixed).toBe(undefined);
    expect(sw.serverWide).toBe(false);

    const ws = await seedBoard(base, { name: 'Harborlight' });
    const path = join(dataDir, 'harborlight-notes.md');
    writeFileSync(path, '# Harborlight notes\n\nIntro paragraph.\n');
    const added = await post(base, `/workspaces/${ws}/docs`, {
      docId: 'harborlight-notes',
      type: 'markdown',
      sourceUrl: path,
    });
    expect(added.status).toBe(200);
    const docId = ((await added.json()) as { docId: string }).docId;
    const open = (): Page => {
      const p = openPage(`${base.replace('http', 'ws')}/workspaces/${ws}/docs/${docId}/y`, base);
      pages.push(p);
      return p;
    };
    const comment = async (text: string): Promise<string> => {
      const r = await post(base, `/workspaces/${ws}/docs/${docId}/threads`, {
        author: { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' },
        text,
        anchor: { kind: 'subject' },
      });
      expect(r.status, await r.clone().text()).toBe(200);
      return ((await r.json()) as { thread: { id: string } }).thread.id;
    };
    const rooms = () => handle.collabCore.path.openRooms();
    /** Everything said so far reaches `p`: text, every comment, every name. */
    const seesAll = async (p: Page, text: string[], threads: string[], who: string[]) => {
      for (const t of text) {
        await waitFor(() => proseText(p.ydoc).includes(t), { describe: `text "${t}"` });
      }
      for (const id of threads) {
        await waitFor(() => threadIds(p.ydoc).includes(id), { describe: `thread ${id}` });
      }
      for (const n of who) {
        await waitFor(() => names(p).includes(n), { describe: `${n} present` });
      }
    };

    // ── On the current code ───────────────────────────────────────────────
    const a = open();
    const b = open();
    await Promise.all([a.ready, b.ready]);
    expect(rooms()).toEqual([]);
    appendParagraph(a.ydoc, 'Typed before the move');
    const t1 = await comment('Which year is this?');
    sit(a, 'Alice');
    await seesAll(b, ['Typed before the move'], [t1], ['Alice']);

    // ── Onto the core: the two settings the board's switch sets ──────────
    sw.setServerWide(true);
    sw.set(ws, true);
    expect(sw.usesCore(ws)).toBe(true);
    // Open pages keep the path they connected with.
    expect(rooms()).toEqual([]);
    const c = open();
    await c.ready;
    expect(rooms()).toEqual([docId]);
    await seesAll(c, ['Typed before the move'], [t1], ['Alice']);
    // A core page and a current-code page sync with each other.
    appendParagraph(c.ydoc, 'Typed on the core');
    await seesAll(a, ['Typed on the core'], [], []);
    appendParagraph(b.ydoc, 'Typed on the old path');
    await seesAll(c, ['Typed on the old path'], [], []);
    sit(c, 'Bob');
    await seesAll(a, [], [], ['Bob']);

    // The open pages reconnect, and now every page is on the core.
    a.close();
    b.close();
    const a2 = open();
    const b2 = open();
    await Promise.all([a2.ready, b2.ready]);
    expect(rooms()).toEqual([docId]);
    expect(handle.docStore.peek(docId)?.conns.size).toBe(3);
    const t2 = await comment('Add the tide tables.');
    sit(a2, 'Alice');
    const allText = ['Typed before the move', 'Typed on the core', 'Typed on the old path'];
    await seesAll(b2, allText, [t1, t2], ['Alice', 'Bob']);
    appendParagraph(a2.ydoc, 'Typed with every page on the core');
    allText.push('Typed with every page on the core');
    await seesAll(b2, allText, [], []);
    await seesAll(c, allText, [t2], ['Alice']);

    // ── Back to the current code ─────────────────────────────────────────
    sw.set(ws, false);
    expect(sw.usesCore(ws)).toBe(false);
    const d = open();
    await d.ready;
    // d took the current code; the three core pages still hold the room.
    expect(rooms()).toEqual([docId]);
    await seesAll(d, allText, [t1, t2], ['Alice', 'Bob']);
    appendParagraph(d.ydoc, 'Typed after the move back');
    allText.push('Typed after the move back');
    await seesAll(c, ['Typed after the move back'], [], []);
    appendParagraph(b2.ydoc, 'Typed on the core after the move back');
    allText.push('Typed on the core after the move back');
    await seesAll(d, ['Typed on the core after the move back'], [], []);

    for (const p of [a2, b2, c]) p.close();
    await waitFor(() => rooms().length === 0, { describe: 'the core lets the room go' });
    const e = open();
    const f = open();
    await Promise.all([e.ready, f.ready]);
    expect(rooms()).toEqual([]);
    const t3 = await comment('Done here.');
    sit(e, 'Alice');
    await seesAll(f, allText, [t1, t2, t3], ['Alice']);
    appendParagraph(f.ydoc, 'Typed with every page back');
    await seesAll(e, ['Typed with every page back'], [], []);
    expect(rooms()).toEqual([]);
  }, 60_000);
});
