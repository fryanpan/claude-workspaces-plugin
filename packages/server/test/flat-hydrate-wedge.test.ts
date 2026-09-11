/**
 * The FLAT doors — code docs and working-tree diff members — on a file that
 * has stopped answering.
 *
 * Every wedge test before this one bound a markdown doc, so the prose door
 * (`attachFile`) was the only one with an end-to-end proof. The flat door
 * (`attachFlatFile`) is reached three ways, and each one hands it a path the
 * caller's tree holds:
 *
 *   - the bind loop over a diff's members — `bind-diff-wedge.test.ts`;
 *   - a hydrate of a flat doc that is not resident — here;
 *   - a click in the all-files sidebar, `openContextFile` — here.
 *
 * The hazard the doors exist for is a read on the main thread: the first
 * caller to touch a freshly-sick file is not refused by the quarantine,
 * because nothing has earned one yet. So each case below asserts what a
 * blocking read would have changed — the doc bound to the pipe's empty
 * answer, or the open succeeding — rather than only that the call returned.
 *
 * A FIFO with no writer is the sick provider: `stat` answers, `open` never
 * returns. The repository and its files are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOC_STORE_TIMINGS } from '../src/doc-store-timings.ts';
import { DocStore } from '../src/doc-store.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { armFifoValve, makeFifo, releaseFifosIn } from './fifo.ts';
import { waitFor } from './wait-for.ts';

/** Well past the read deadline — see `armFifoValve`. */
const VALVE_MS = DOC_STORE_TIMINGS.boundReadDeadlineMs * 6;

function git(repo: string, args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
}

function newStore(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

describe('a flat doc whose file has stopped answering', () => {
  let dataDir: string;
  let repo: string;
  let store: DocStore | undefined;
  let reviewId = '';
  /** A working-tree diff member: flat, and written back. */
  let memberId = '';
  /** A context file opened from the sidebar: flat and read-only. */
  let contextId = '';
  const disarm: Array<() => void> = [];

  beforeEach(async () => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'flat-wedge-data-'));
    repo = mkdtempSync(join(tmpdir(), 'flat-wedge-repo-'));
    git(repo, ['init', '-q', '.']);
    git(repo, ['config', 'user.email', 'reviewer@example.invalid']);
    git(repo, ['config', 'user.name', 'Test Reviewer']);
    writeFileSync(join(repo, 'ledger.kt'), 'fun ledger() = 1\n');
    writeFileSync(join(repo, 'planner.kt'), 'fun plan() = 1\n');
    writeFileSync(join(repo, 'routes.kt'), 'fun route() = 1\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);
    appendFileSync(join(repo, 'ledger.kt'), 'fun ledger2() = 2\n');

    // Round one: everything answers. A review with one changed member, and one
    // unchanged file opened for context, both bound and persisted.
    const first = newStore(dataDir);
    const bound = await first.bindDiff({ repoPath: repo, base: 'HEAD' });
    if (!bound.ok) throw new Error(`round one could not bind: ${JSON.stringify(bound)}`);
    reviewId = bound.reviewId;
    memberId = bound.files.find((f) => f.relPath === 'ledger.kt')?.docId ?? '';
    const opened = await first.openContextFile(reviewId, 'planner.kt');
    if (!opened.ok) throw new Error(`round one could not open: ${JSON.stringify(opened)}`);
    contextId = opened.docId;
    expect(first.boundPathOf(memberId)).toBe(join(repo, 'ledger.kt'));
    expect(first.boundPathOf(contextId)).toBe(join(repo, 'planner.kt'));
    first.flush();
    first.stop();

    // The folder goes bad under all three files. They still exist, still
    // stat, and are still tracked, so every door still intends to open them.
    for (const name of ['ledger.kt', 'planner.kt', 'routes.kt']) {
      unlinkSync(join(repo, name));
      makeFifo(join(repo, name));
      disarm.push(armFifoValve(join(repo, name), VALVE_MS, 'write'));
    }
  });

  afterEach(async () => {
    for (const off of disarm.splice(0)) off();
    store?.stop();
    store = undefined;
    await releaseFifosIn(repo);
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const text = (docId: string) => store?.peek(docId)?.ydoc.getText('content').toString();

  it('a hydrate of a flat doc parks it on its .ydoc instead of reading the file', async () => {
    store = newStore(dataDir);

    // Neither doc is resident, so each `get` hydrates — the door a board's
    // fan-out, a comment on the doc or a timer reaches.
    expect(store.get(memberId)).toBeDefined();
    expect(store.get(contextId)).toBeDefined();

    // What a read on the main thread would have done: bound the doc to the
    // pipe and replaced its content with whatever the pipe gave back. Parked
    // instead, the content is the `.ydoc`'s and nothing is bound.
    expect(store.boundPathOf(memberId)).toBeUndefined();
    expect(store.boundPathOf(contextId)).toBeUndefined();
    expect(text(memberId)).toBe('fun ledger() = 1\nfun ledger2() = 2\n');
    expect(text(contextId)).toBe('fun plan() = 1\n');

    // The pool read that took the file's place blows its deadline and
    // quarantines the path, and the doc says so to its owner.
    await waitFor(
      () =>
        boundFiles.quarantined(join(repo, 'ledger.kt')) &&
        boundFiles.quarantined(join(repo, 'planner.kt')),
      { describe: 'both deferred reads to be written off' },
    );
    for (const docId of [memberId, contextId]) {
      expect(store.getDocStatus(docId)?.sourceParked?.reason).toContain('quarantined');
    }
    expect(text(memberId)).toBe('fun ledger() = 1\nfun ledger2() = 2\n');
  });

  it('opening an unchanged file from the sidebar answers unavailable, not a pipe’s empty read', async () => {
    store = newStore(dataDir);
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 20);

    const opening = store.openContextFile(reviewId, 'routes.kt');
    // The loop runs while the open is outstanding.
    await waitFor(() => ticked, { describe: 'a timer armed before the open to fire' });

    // A blocking read gets end-of-file from the valve, and the open then
    // succeeds with an empty doc bound to the pipe. Refused is the honest
    // verdict: the file is there, and it is not answering.
    expect(await opening).toEqual({ ok: false, error: 'unavailable' });
    expect(boundFiles.quarantined(join(repo, 'routes.kt'))).toBe(true);
  });

  it('positive control: the same doors bind and read the same files when they answer', async () => {
    for (const off of disarm.splice(0)) off();
    for (const [name, body] of [
      ['ledger.kt', 'fun ledger() = 1\nfun ledger2() = 2\n'],
      ['planner.kt', 'fun plan() = 1\n'],
      ['routes.kt', 'fun route() = 1\n'],
    ] as const) {
      unlinkSync(join(repo, name));
      writeFileSync(join(repo, name), body);
    }
    store = newStore(dataDir);

    // The hydrate defers the read either way; a file that answers binds a
    // moment later, with the file's bytes.
    store.get(memberId);
    store.get(contextId);
    await waitFor(() => store?.boundPathOf(memberId) && store?.boundPathOf(contextId), {
      describe: 'both deferred binds to land',
    });
    expect(store.getDocStatus(memberId)?.sourceParked).toBeUndefined();

    const opened = await store.openContextFile(reviewId, 'routes.kt');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(store.boundPathOf(opened.docId)).toBe(join(repo, 'routes.kt'));
    expect(text(opened.docId)).toBe('fun route() = 1\n');
  });
});
