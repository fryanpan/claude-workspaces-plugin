/**
 * A parked doc comes back to its file on its own, and says it is parked to
 * whoever edits it.
 *
 * A doc parks when its bound file stops answering: it keeps serving its
 * `.ydoc`, takes no binding, and writes nothing to the file. Two things were
 * wrong with that state once the doc was resident.
 *
 *   - It never ended. `resolveDoc` finds a resident doc in memory and returns
 *     it, the deferred bind that parked it had had its one read, and nothing
 *     else hydrates a loaded doc — so the file's 60s quarantine expired and
 *     the doc stayed parked until eviction or a restart, with every edit
 *     since kept out of the file.
 *   - It was silent to the editor. The park's only account on an edit was one
 *     `console.warn` in a server log; `syncError` lives on the binding, and a
 *     park is the absence of one.
 *
 * The quarantine's backoff is the clock here, so the test advances `Date.now`
 * past it rather than waiting it out.
 *
 * A FIFO with no writer is the sick file: `stat` answers, `open` never
 * returns. The board, the doc and the paths are invented.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOC_STORE_TIMINGS } from '../src/doc-store-timings.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { type AccessHarness, accessHarness } from './access-share.ts';
import { makeFifo, releaseFifosIn } from './fifo.ts';
import { waitFor, waitForFile } from './wait-for.ts';

const DOC_ID = 'parked-then-back';
const LEAD = { id: 'agent-surveyor', name: 'Surveyor', kind: 'agent' };
const FIRST = '# Field notes\n\nA readable first version.\n';

type Status = { bound: boolean; sourceParked?: { reason: string; at: number } };

describe('a resident doc parked on a file that stopped answering', () => {
  let dataDir: string;
  let scratch: string;
  let boundPath: string;
  let ws: string;
  let access: AccessHarness;
  let handle: ServerHandle | undefined;
  let clock: ReturnType<typeof spyOn> | undefined;

  beforeEach(async () => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'park-retry-data-'));
    scratch = mkdtempSync(join(tmpdir(), 'park-retry-files-'));
    boundPath = join(scratch, 'notes.md');
    writeFileSync(boundPath, FIRST);
    access = await accessHarness();

    // Round one: the file answers. Create, bind and attach the doc, then shut
    // down so the next round has to hydrate it from disk.
    const first = createServer({ port: 0, dataDir, ...access.serverOptions });
    const base = `http://localhost:${first.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const made = await post('/workspaces', { name: 'field-survey', leadAgentId: LEAD.id });
    ws = ((await made.json()) as { workspace: { id: string } }).workspace.id;
    const doc = { docId: DOC_ID, type: 'markdown', sourceUrl: boundPath };
    expect((await post(`/workspaces/${ws}/docs`, doc)).status).toBe(200);
    expect((await post(`/workspaces/${ws}/docs:attach`, { docId: DOC_ID })).status).toBe(200);
    first.tasks.flush();
    await first.stop();

    // The folder goes bad under the file.
    unlinkSync(boundPath);
    makeFifo(boundPath);
  });

  afterEach(async () => {
    clock?.mockRestore();
    clock = undefined;
    await handle?.stop();
    handle = undefined;
    await releaseFifosIn(scratch);
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it('tells an editor it is parked, then re-binds once the quarantine expires', async () => {
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    const base = `http://localhost:${handle.port}`;
    const docUrl = `${base}/workspaces/${ws}/docs/${DOC_ID}`;
    const status = async () => (await (await fetch(`${docUrl}/status`)).json()) as Status;

    // Reaching the doc hydrates it. Its read goes to the pool, blows the
    // deadline, and quarantines the path; the doc parks on its `.ydoc`.
    expect((await status()).bound).toBe(false);
    await waitFor(() => boundFiles.quarantined(boundPath), {
      describe: 'the read of the pipe to be written off',
    });
    expect((await status()).sourceParked?.reason).toContain('quarantined');

    // An edit to the parked doc lands in the `.ydoc` and nowhere else, and
    // the response is where whoever made it is looking.
    const edited = await fetch(`${docUrl}/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'readable', replace: 'recovered' }),
    });
    expect(edited.status).toBe(200);
    const note = ((await edited.json()) as { syncError?: { message: string } }).syncError;
    expect(note?.message).toContain('parked');
    // The edit response has no visitor strip, so the note carries no path.
    expect(note?.message).not.toContain(scratch);

    // The folder comes back. The pipe's parked read is released first, so
    // the pool is not left holding a thread, and the file is an ordinary one
    // again — written now, so it is newer than the `.ydoc`.
    await releaseFifosIn(scratch);
    unlinkSync(boundPath);
    writeFileSync(boundPath, FIRST);

    // Nothing but the backoff stands in the way now, and nobody touches the
    // doc again: the re-bind has to come from the store itself.
    const skew = DOC_STORE_TIMINGS.boundReadRetryMs + 1;
    const realNow = Date.now.bind(Date);
    clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    await waitFor(
      () => !boundFiles.quarantined(boundPath) && handle?.docStore.boundPathOf(DOC_ID),
      {
        describe: 'the parked doc to re-bind on its own',
      },
    );

    // The edit made while it was parked reaches the file, rather than the
    // file's bytes — newer, and never shown that edit — reverting it.
    await waitForFile(boundPath, (text) => text.includes('A recovered first version.'));
    const healthy = await status();
    expect(healthy.bound).toBe(true);
    expect(healthy.sourceParked).toBeUndefined();

    // And the next edit carries no park note: the doc is bound again.
    const after = await fetch(`${docUrl}/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'recovered', replace: 'restored' }),
    });
    expect(((await after.json()) as { syncError?: unknown }).syncError).toBeUndefined();
  });
});
