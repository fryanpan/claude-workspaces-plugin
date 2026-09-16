/**
 * The stall scan walks every doc on a board. One that will not answer must
 * not stop it.
 *
 * `hydrate-wedge.test.ts` covers the REQUEST paths — an SSE subscribe, a doc
 * GET. This file covers the other half of the 2026-09-04 shape, and the half
 * with no client on the end of it: a TIMER. `nudgeStalls` runs on a 60s
 * interval, and `heldThreadReviewItems` inside it calls `docStore.listThreads`
 * once per task body, once per goal body and once per attached doc — none of
 * which reaches a URL, so nothing prewarms them. On the pre-fix code the first
 * cold doc bound into a sick folder parked the whole process from a timer
 * callback, with no request to blame it on.
 *
 * A FIFO with no writer is the reproduction: `stat` answers, `open` blocks
 * until somebody opens the other end, and in this file nobody ever does.
 *
 * NOTE ON FAILURE MODE: a regression here does not fail this test, it HANGS
 * it — `nudgeStalls` is synchronous, so a blocking read inside it parks the
 * runner and the assertions below are never reached. The runner's own timeout
 * is what turns that into a red test. That is inherent to asserting on a
 * synchronous call; there is no way to race a timer against code that owns
 * the only thread. Verified by mutation: restoring the synchronous fallback
 * in `DocStore.prereadFor` hangs this file rather than failing it.
 *
 * WHAT THE SCAN COSTS NOW: nothing on the file at all. Since 2026-09-16 a
 * thread listing resolves its doc WITHOUT arming a file binding — a fan-out
 * over a board woke ~2,500 dormant bindings and they flushed weeks-old
 * content over files on disk — so the scan reads the `.ydoc` and never opens
 * the bound path. The wedge property this file was written for is therefore
 * stronger than it was: there is no read to park on, sick folder or not.
 *
 * The anti-vacuity assertion is what changed with it. It used to be a pool
 * read outstanding when the scan returned, which proved the scan had reached
 * the doc through the async door. With no read at all, what proves the scan
 * reached the doc is that the doc is RESIDENT and UNBOUND: in memory from
 * its `.ydoc`, holding no binding. A scan that skipped the doc leaves it
 * neither.
 *
 * The board, the doc and the paths here are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { makeFifo, releaseFifosIn } from './fifo.ts';
import { seedBoard } from './workspace-seed.ts';

const DOC_ID = 'board-doc-that-stopped-answering';
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('the stall scan over a board holding an unreadable doc', () => {
  let dataDir: string;
  let scratch: string;
  let boundPath: string;
  let workspaceId: string;
  let handle: ServerHandle | undefined;

  /** Round one: an ordinary board with an ordinary readable doc on it. */
  beforeEach(async () => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'stall-scan-data-'));
    scratch = mkdtempSync(join(tmpdir(), 'stall-scan-files-'));
    boundPath = join(scratch, 'design.md');
    writeFileSync(boundPath, '# Design\n\nA readable first version.\n');

    const first = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://127.0.0.1:${first.port}`;
    WS = await seedBoard(base);
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const created = await post('/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id });
    expect(created.status).toBe(200);
    workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    WS = workspaceId;

    expect(
      (
        await post(`/workspaces/${WS}/docs`, {
          docId: DOC_ID,
          type: 'markdown',
          sourceUrl: boundPath,
        })
      ).status,
    ).toBe(200);
    // Onto the board itself: `heldThreadReviewItems` walks `workspace.docIds`,
    // which is the loop this test is about. A doc merely LINKED to a row is
    // reached by a different walk.
    expect((await post(`/workspaces/${workspaceId}/docs:attach`, { docId: DOC_ID })).status).toBe(
      200,
    );
    await first.stop();

    // The folder goes bad. Everything else about the path is unchanged — it
    // exists, it stats, it is still the doc's recorded source.
    unlinkSync(boundPath);
    makeFifo(boundPath);
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    // A read parked on an unlinked pipe can never be released and owns a pool
    // thread until it is; this throws rather than letting the runner hang.
    await releaseFifosIn(scratch);
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it('finishes a pass without opening the doc it could not read', async () => {
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    // The doc is COLD: neither boot pass opens it (nothing had an un-flushed
    // write, and its `.ydoc` already has an index row), so the scan below is
    // the first thing to ask for it.
    expect(handle.docStore.boundPathOf(DOC_ID)).toBeUndefined();

    // A DELTA, not a total: `boundFiles` is one module-level pool shared by
    // every test in this process, so a neighbouring file's read in flight
    // makes the total whatever it likes. What this scan costs is the change.
    const inflightBefore = boundFiles.stats().inflight;
    handle.nudgeStalls();

    // The scan RETURNED, and it started no read of its own: a thread listing
    // no longer opens the bound file at all.
    expect(boundFiles.stats().inflight).toBe(inflightBefore);

    // Not a vacuous pass. The doc is in memory — so the scan did reach it —
    // and it holds no binding, which is the whole of what the read may cost.
    expect(handle.docStore.peek(DOC_ID)).toBeDefined();
    expect(handle.docStore.getDocStatus(DOC_ID)?.bound).toBe(false);

    // And the file is untouched: a doc that binds without having read its file
    // overwrites that file on the next write-back.
    expect(statSync(boundPath).isFIFO()).toBe(true);
  });

  it('positive control: a readable file is not what was stopping it, and a content read still binds', async () => {
    // Same board, same pass, with the FIFO swapped back for a real file.
    // Two things to prove, and the second is what keeps the case above
    // honest.
    unlinkSync(boundPath);
    writeFileSync(boundPath, '# Design\n\nA readable first version.\n');

    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    handle.nudgeStalls();

    // One: the scan binds nothing even when the file would answer happily,
    // so the case above measured the rule and not the sick folder.
    expect(handle.docStore.boundPathOf(DOC_ID)).toBeUndefined();
    expect(handle.docStore.peek(DOC_ID)).toBeDefined();

    // Two: binding still works in this fixture. A read of the doc's CONTENT
    // arms it, deferred onto the pool, so give the read a turn to land.
    handle.docStore.get(DOC_ID);
    for (let i = 0; i < 50 && handle.docStore.boundPathOf(DOC_ID) === undefined; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(handle.docStore.boundPathOf(DOC_ID)).toBe(boundPath);
    expect(handle.docStore.getDocStatus(DOC_ID)?.sourceParked).toBeUndefined();
  });
});
