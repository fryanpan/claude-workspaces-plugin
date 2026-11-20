/**
 * An edit on a board on the collab core reaches a second page's stored state
 * within 1s (M8 cutover trial, bar 2, the socket half).
 *
 * Real server on port 0 over a temp data folder, two raw pages on the doc's
 * real socket, on the named doc `TIDE_TABLE` (`core-edit-latency.ts`). The
 * bar is a latency, so this is one of the few tests that asserts a time: the
 * number is read off two clocks recorded at the events themselves (the edit
 * and the second page's own update handler), and printed with the doc size so
 * the CI log carries the measurement. The screen half, in a real browser, is
 * `workspaces-app/test/core-edit-latency-browser.test.ts`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type Page, openPage, proseText } from './collab-core-page.ts';
import { STORED_BAR_MS, TIDE_TABLE, latencyLine, measureStored } from './core-edit-latency.ts';
import { seedBoard } from './workspace-seed.ts';

const dirs: string[] = [];
const handles: ServerHandle[] = [];
const pages: Page[] = [];

afterEach(async () => {
  for (const p of pages.splice(0)) p.close();
  for (const h of handles.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('an edit on a board on the core', () => {
  it('reaches a second page’s stored state within 1s on the Harborlight tide table', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'collab-core-latency-'));
    dirs.push(dataDir);
    const handle = createServer({
      port: 0,
      dataDir,
      collabCoreDefault: true,
      requireSignInToWrite: false,
    });
    handles.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;
    const ws = await seedBoard(base, { name: 'Harborlight' });
    const path = join(dataDir, 'tide-table.md');
    writeFileSync(path, TIDE_TABLE);
    const r = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'tide-table', type: 'markdown', sourceUrl: path }),
    });
    expect(r.status).toBe(200);
    const docId = ((await r.json()) as { docId: string }).docId;

    const url = `${base.replace('http', 'ws')}/workspaces/${ws}/docs/${docId}/y`;
    const one = openPage(url, base);
    const two = openPage(url, base);
    pages.push(one, two);
    await Promise.all([one.ready, two.ready]);
    // Both pages hold the whole doc, so the edit lands on the named size.
    expect(proseText(two.ydoc)).toContain('Week 200');
    // And both are served by the core, not the current code.
    expect(handle.collabCore.path.openRooms()).toEqual([docId]);

    const runs = [];
    for (let i = 1; i <= 5; i++) {
      runs.push(await measureStored(one, two, `Riverbend ferry run ${i} leaves on the hour.`));
    }
    const worst = Math.max(...runs.map((m) => m.storedMs));
    console.log(latencyLine('stored state, worst of 5', worst, STORED_BAR_MS));
    console.log(
      `[core-edit-latency] stored state, each run: ${runs.map((m) => m.storedMs.toFixed(1)).join(', ')}ms`,
    );
    expect(worst).toBeLessThan(STORED_BAR_MS);
    // A boot, a seed, a 29 KB doc and five edits: past bun's 5s default on a
    // loaded machine, which is the case limit and not the bar.
  }, 30_000);
});
