/**
 * Doc history on a real server, for a board switched onto the collab core
 * (D1 step 12, done-when lines 1 and 3, and the switch's promise that turning
 * it off loses nothing).
 *
 * Real servers on port 0 over temp data folders, real doc sockets signed in
 * the way a browser signs in, and the REST edit route an agent's MCP tool
 * calls. Every wait polls for the record it needs.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { historyDir } from '../src/doc-history/log.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { signIn } from './auth-widget-token-harness.ts';
import { type Page, appendParagraph, openPage, proseText } from './collab-core-page.ts';
import { waitFor, waitForFile } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const MSG_AWARENESS = 1;
const dirs: string[] = [];
const handles: ServerHandle[] = [];
const pages: Page[] = [];

afterEach(async () => {
  for (const p of pages.splice(0)) p.close();
  for (const h of handles.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function boot(dataDir: string, opts: { collabCore: boolean; requireSignInToWrite: boolean }) {
  const handle = createServer({ port: 0, dataDir, emailCodeSignIn: true, ...opts });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}

async function stop(handle: ServerHandle): Promise<void> {
  handles.splice(handles.indexOf(handle), 1);
  await handle.stop();
}

const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cw-doc-history-server-'));
  dirs.push(d);
  return d;
};

async function post(base: string, path: string, body: unknown, headers = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** A markdown doc on board `ws`, bound to a file in the data folder. */
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

/** A doc page, optionally signed in, announcing `name` as its presence. */
function page(base: string, ws: string, docId: string, name: string, cookie?: string): Page {
  const url = `${base.replace('http', 'ws')}/workspaces/${ws}/docs/${docId}/y`;
  const p = openPage(url, base, { ...(cookie ? { cookie } : {}) });
  pages.push(p);
  // The name a page claims for itself: what the record must NOT believe.
  const awareness = new awarenessProtocol.Awareness(p.ydoc);
  awareness.setLocalStateField('user', { name, color: '#336699' });
  void p.ready.then(() => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [p.ydoc.clientID]),
    );
    p.sendRaw(encoding.toUint8Array(enc));
    awareness.destroy();
  });
  return p;
}

async function board(base: string, name: string, on: boolean): Promise<string> {
  const ws = await seedBoard(base, { name });
  const r = await post(base, `/workspaces/${ws}/collab-core`, { on });
  expect(r.status).toBe(200);
  return ws;
}

const updates = (h: ServerHandle, docId: string) =>
  h.docHistory.versions(docId).filter((v) => v.kind !== 'base');

/** Wait until the server holds `words` in the doc and has recorded the
 *  person's edit that put them there; returns that record's seq. */
async function recorded(h: ServerHandle, docId: string, words: string): Promise<number> {
  await waitFor(() => proseText(h.docStore.peek(docId)?.ydoc ?? new Y.Doc()).includes(words), {
    describe: `"${words}" on the server`,
  });
  const rec = await waitFor(
    () => {
      const v = h.docHistory.versions(docId);
      const last = v.at(-1);
      if (!last || last.author.kind !== 'person') return null;
      const read = h.docHistory.read(docId, { seq: last.seq });
      const has = proseText(read.doc).includes(words);
      read.doc.destroy();
      return has ? last : null;
    },
    { describe: `the record holding "${words}"` },
  );
  return rec.seq;
}

describe('done-when 1: every saved change records who made it, from the server’s identity', () => {
  it('records the signed-in person, not the name the page announces', async () => {
    const dataDir = freshDir();
    const { handle, base } = boot(dataDir, { collabCore: true, requireSignInToWrite: true });
    const ws = await board(base, 'Harborlight', true);
    const docId = await addDoc(base, dataDir, ws, 'harborlight-notes');
    const cookie = await signIn(base, 'alice@example.com');
    const alice = page(base, ws, docId, 'Bob', cookie);
    await alice.ready;
    // Positive control: this socket took the core path.
    expect(handle.collabCore.path.openRooms()).toEqual([docId]);

    appendParagraph(alice.ydoc, 'Riverbend tide tables');
    const [rec] = await waitFor(
      () => {
        const u = updates(handle, docId).filter((v) => v.author.kind === 'person');
        return u.length > 0 ? u : null;
      },
      { describe: 'a recorded edit from the page' },
    );
    expect(rec?.author.id).toMatch(/^user-/);
    expect(rec?.author.name).toBe('Alice');
    expect(updates(handle, docId).every((v) => v.author.name !== 'Bob')).toBe(true);
  }, 30_000);

  it('records a page that proved nobody as an unnamed person, never its announced name', async () => {
    const dataDir = freshDir();
    const { handle, base } = boot(dataDir, { collabCore: true, requireSignInToWrite: false });
    const ws = await board(base, 'Harborlight', true);
    const docId = await addDoc(base, dataDir, ws, 'harborlight-notes');
    const p = page(base, ws, docId, 'Bob');
    await p.ready;
    appendParagraph(p.ydoc, 'Saltmarsh closes at six');
    const [rec] = await waitFor(
      () => {
        const u = updates(handle, docId).filter((v) => v.author.kind === 'person');
        return u.length > 0 ? u : null;
      },
      { describe: 'a recorded edit from the page' },
    );
    expect(rec?.author).toEqual({ kind: 'person' });
  }, 30_000);

  it('records an agent’s edit as the agent its board token proved, not a name in the body', async () => {
    const dataDir = freshDir();
    const { handle, base } = boot(dataDir, { collabCore: true, requireSignInToWrite: true });
    const ws = await board(base, 'Harborlight', true);
    const docId = await addDoc(base, dataDir, ws, 'harborlight-notes');
    const { token } = handle.boardTokens.mintHeld('agent-riverbend', ws);
    const r = await post(
      base,
      `/workspaces/${ws}/docs/${docId}/find_and_replace`,
      {
        find: 'Intro paragraph.',
        replace: 'Intro paragraph, edited.',
        author: { id: 'person-alice', name: 'Alice', kind: 'known' },
      },
      { authorization: `Bearer ${token}` },
    );
    expect(r.ok).toBe(true);
    const [rec] = await waitFor(
      () => {
        const u = updates(handle, docId).filter((v) => v.author.kind === 'agent');
        return u.length > 0 ? u : null;
      },
      { describe: 'the agent’s recorded edit' },
    );
    expect(rec?.author.id).toBe('agent-riverbend');
    expect(rec?.author.name).not.toBe('Alice');
  }, 30_000);

  it('records nothing for a board on the current code', async () => {
    const dataDir = freshDir();
    const { handle, base } = boot(dataDir, { collabCore: true, requireSignInToWrite: false });
    const on = await board(base, 'Harborlight', true);
    const off = await board(base, 'Riverbend', false);
    const onDoc = await addDoc(base, dataDir, on, 'harborlight-notes');
    const offDoc = await addDoc(base, dataDir, off, 'riverbend-notes');
    const a = page(base, on, onDoc, 'Alice');
    const b = page(base, off, offDoc, 'Alice');
    await Promise.all([a.ready, b.ready]);
    appendParagraph(a.ydoc, 'Harborlight edit');
    appendParagraph(b.ydoc, 'Riverbend edit');
    // Positive control: the switched-on board's edit is recorded.
    await waitFor(() => updates(handle, onDoc).length > 0, { describe: 'the on board’s record' });
    await waitFor(() => proseText(handle.docStore.peek(offDoc)!.ydoc).includes('Riverbend edit'), {
      describe: 'the off board’s edit on the server',
    });
    expect(handle.docHistory.versions(offDoc)).toEqual([]);
    expect(existsSync(join(historyDir(dataDir), `${offDoc}.yhist`))).toBe(false);
  }, 30_000);
});

describe('done-when 3: a restore is a recorded change, and the version it replaced still reads', () => {
  it('restores over a live page, writes the file, and keeps the replaced version', async () => {
    const dataDir = freshDir();
    const { handle, base } = boot(dataDir, { collabCore: true, requireSignInToWrite: false });
    const ws = await board(base, 'Harborlight', true);
    const docId = await addDoc(base, dataDir, ws, 'harborlight-notes');
    const p = page(base, ws, docId, 'Alice');
    await p.ready;
    appendParagraph(p.ydoc, 'First paragraph');
    const target = await recorded(handle, docId, 'First paragraph');
    appendParagraph(p.ydoc, 'Second paragraph');
    const replacedSeq = await recorded(handle, docId, 'Second paragraph');

    const live = handle.docStore.peek(docId);
    expect(live).toBeDefined();
    const riverbend = { kind: 'agent' as const, id: 'agent-riverbend', name: 'Riverbend' };
    const result = handle.docHistory.restore(live!, target, riverbend);
    expect(result.seq).toBe(replacedSeq + 1);
    expect(handle.docHistory.versions(docId).at(-1)).toMatchObject({
      kind: 'restore',
      restoredTo: target,
      author: riverbend,
    });
    // The open page shows the restore without a reload, and the file follows.
    await waitFor(() => !proseText(p.ydoc).includes('Second paragraph'), {
      describe: 'the restore on the open page',
    });
    expect(proseText(p.ydoc)).toContain('First paragraph');
    await waitForFile(join(dataDir, 'harborlight-notes.md'), (t) => !t.includes('Second'));
    // The version before the restore is still there to read.
    const replaced = handle.docHistory.read(docId, { seq: replacedSeq });
    expect(replaced.doc.getXmlFragment('prose').toString()).toContain('Second paragraph');
    replaced.doc.destroy();
  }, 30_000);
});

describe('switching off loses nothing', () => {
  it('serves every recorded edit from the .ydoc with the core off, and history comes back on', async () => {
    const dataDir = freshDir();
    const first = boot(dataDir, { collabCore: true, requireSignInToWrite: false });
    const ws = await board(first.base, 'Harborlight', true);
    const docId = await addDoc(first.base, dataDir, ws, 'harborlight-notes');
    const p = page(first.base, ws, docId, 'Alice');
    await p.ready;
    appendParagraph(p.ydoc, 'Kept through the switch');
    await recorded(first.handle, docId, 'Kept through the switch');
    p.close();
    await stop(first.handle);

    const off = boot(dataDir, { collabCore: false, requireSignInToWrite: false });
    const kept = off.handle.docHistory.versions(docId).length;
    expect(kept).toBeGreaterThan(0);
    const q = page(off.base, ws, docId, 'Alice');
    await q.ready;
    expect(proseText(q.ydoc)).toContain('Kept through the switch');
    appendParagraph(q.ydoc, 'Typed while off');
    await waitForFile(join(dataDir, 'harborlight-notes.md'), (t) => t.includes('Typed while off'));
    // Nothing recorded while off.
    expect(off.handle.docHistory.versions(docId).length).toBe(kept);
    q.close();
    await stop(off.handle);

    const back = boot(dataDir, { collabCore: true, requireSignInToWrite: false });
    const r = page(back.base, ws, docId, 'Alice');
    await r.ready;
    appendParagraph(r.ydoc, 'Typed on again');
    // A base for the edit made while off, then the new edit on top of it.
    await waitFor(() => back.handle.docHistory.versions(docId).length >= kept + 2, {
      describe: 'a base and the new record',
    });
    const kinds = back.handle.docHistory
      .versions(docId)
      .slice(kept)
      .map((v) => v.kind);
    expect(kinds[0]).toBe('base');
    const now = back.handle.docHistory.read(docId, { seq: Number.MAX_SAFE_INTEGER });
    expect(now.doc.getXmlFragment('prose').toString()).toContain('Typed while off');
    now.doc.destroy();
    expect(readFileSync(join(dataDir, 'harborlight-notes.md'), 'utf8')).toContain('Kept');
  }, 60_000);
});
