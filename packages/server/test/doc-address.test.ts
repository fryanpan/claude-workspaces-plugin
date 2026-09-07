/**
 * A document that can hold content has an address — the invariant behind
 * the stranded-documents ticket.
 *
 * `withReviewUrl` mints a doc's only URL under the board that holds it, so a
 * content doc no board holds is one nobody can open. Measured on 2026-09-06:
 * 30 live markdown docs on the production box were in that state, created
 * before filing existed or through the store directly. This file asserts the
 * two halves of the fix — a doc created through the route is filed on the
 * spot, and a doc that reached the store any other way is filed at the next
 * boot — against the real server, and the invariant itself against the
 * store's listing. All fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docIdsNeedingFiling } from '../src/attachment-backfill.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

type Listed = { docId: string; reviewUrl?: string };

let dataDir: string;
let handle: ServerHandle;
let base: string;

function boot(): void {
  handle = createServer({ port: 0, dataDir, stallNudgeQuietMs: 60 * 60_000 });
  base = `http://localhost:${handle.port}`;
}

/** The invariant, read off the live store the way the boot pass reads it. */
function unaddressed(): string[] {
  return docIdsNeedingFiling(
    handle.docStore.list(),
    (id) => handle.tasks.workspaceOfDoc(id) !== null,
  );
}

async function listDocs(workspaceId: string): Promise<Listed[]> {
  const res = await fetch(`${base}/workspaces/${workspaceId}/docs`);
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { docs?: Listed[] } | Listed[];
  return Array.isArray(body) ? body : (body.docs ?? []);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'doc-address-'));
  boot();
});
afterEach(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('every content doc has an address', () => {
  it('holds for a doc created through the route, which is filed on the spot', async () => {
    const ws = await seedBoard(base);
    const file = join(dataDir, 'notes.md');
    writeFileSync(file, '# Notes\n\nA paragraph.\n');
    const res = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'd-notes', type: 'markdown', sourceUrl: file }),
    });
    expect(res.ok, await res.clone().text()).toBe(true);
    const { docId } = (await res.json()) as { docId: string };
    expect(handle.tasks.workspaceOfDoc(docId)).toBe(ws);
    expect(unaddressed()).toEqual([]);
    const row = (await listDocs(ws)).find((d) => d.docId === docId);
    expect(row?.reviewUrl).toContain(`/workspaces/${ws}/docs/`);
  });

  it('is broken by a doc that reached the store without a board, and the next boot mends it', async () => {
    // The way the 30 got there: the store, not the route.
    const doc = handle.docStore.getOrCreate('d-orphan', { type: 'markdown', title: 'Orphan' });
    doc.ydoc.getText('content').insert(0, 'Writing nobody can open.');
    expect(unaddressed()).toEqual(['d-orphan']);
    // A mockup with no source is the control: it has no page to open, so it
    // is not a broken invariant and the boot pass must not put a row up for it.
    handle.docStore.getOrCreate('d-nomock', { type: 'mockup', title: 'Blank' });
    expect(unaddressed()).toEqual(['d-orphan']);
    await handle.stop();

    boot();
    await waitFor(() => unaddressed().length === 0, { describe: 'boot pass files the orphan' });
    const home = handle.tasks.workspaceOfDoc('d-orphan');
    expect(home).not.toBeNull();
    expect(handle.tasks.workspaceOfDoc('d-nomock')).toBeNull();
    const row = (await listDocs(home ?? '')).find((d) => d.docId === 'd-orphan');
    expect(row?.reviewUrl).toContain(`/workspaces/${home}/docs/d-orphan`);
  });

  it('is empty on a fresh server, so a clean boot files nothing', () => {
    expect(unaddressed()).toEqual([]);
  });
});
