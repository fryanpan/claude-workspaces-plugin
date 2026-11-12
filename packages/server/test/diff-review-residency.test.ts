import { heapStats } from 'bun:jsc';
/**
 * A live diff review held open for hours must not hold every file it lists
 * in memory.
 *
 * A working-tree review is re-diffed whenever its listing moves
 * (`folder-watch.ts` → `refreshWorkspace` → `bindDiff`). The re-diff used to
 * `getOrCreate` every member, which stamps each one as reached, so no member
 * of a review a page held open ever aged past the thirty-minute window
 * (`doc-residency.ts`) — the files nobody had opened included, each one
 * re-hydrated if it had gone. Measured: a 5KB source file costs ~34KB of heap
 * resident, a 30KB one ~176KB, and a review may list 300.
 *
 * The rule these pin: a refresh reaches only the members whose diff moved.
 * The rest are left as they are — evicted if their window ran out — and come
 * back, bound to the current file, the moment anybody opens one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memberDocId } from '../src/binds.ts';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

const MINUTE = 60_000;
const FILES = 40;

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

/** About `bytes` of plausible TypeScript. */
function source(bytes: number): string {
  let s = '';
  for (let i = 0; s.length < bytes; i++) {
    s += `export function harborlight${i}(x: number): number {\n  return x * ${i} + ${i};\n}\n\n`;
  }
  return s;
}

function heapBytes(): number {
  Bun.gc(true);
  Bun.gc(true);
  return heapStats().heapSize;
}

describe('a live diff review held open across refresh ticks', () => {
  let dataDir: string;
  let repo: string;
  let store: DocStore;
  let clock: number;
  let base: string;
  const body = source(30_000);
  const rel = (i: number) => `src/f${i}.ts`;

  beforeEach(() => {
    clock = Date.now();
    dataDir = mkdtempSync(join(tmpdir(), 'drr-data-'));
    repo = mkdtempSync(join(tmpdir(), 'drr-repo-'));
    git(repo, 'init', '-q');
    mkdirSync(join(repo, 'src'));
    for (let i = 0; i < FILES; i++) writeFileSync(join(repo, rel(i)), body);
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    base = git(repo, 'rev-parse', 'HEAD');
    for (let i = 0; i < FILES; i++) writeFileSync(join(repo, rel(i)), `${body}// Riverbend ${i}\n`);
    store = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      now: () => clock,
    });
  });

  afterEach(async () => {
    store.flush();
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  /** One refresh tick: an agent edits `file`, the listing moves, the review
   *  is re-diffed, and the idle sweep runs. */
  async function tick(setId: string, n: number, file: number): Promise<void> {
    clock += 5 * MINUTE;
    writeFileSync(join(repo, rel(file)), `${body}// Riverbend ${file}\n${'// edit\n'.repeat(n)}`);
    const res = await store.refreshWorkspace(setId);
    if (!res.ok) throw new Error(`refresh failed: ${JSON.stringify(res)}`);
    await store.evictIdleDocs();
  }

  it('keeps only the members whose diff moved, and heap falls back as the rest age out', async () => {
    // Warm up under another review id and let it age out, so code the bind
    // path compiles on first use is not counted as doc heap below.
    const warm = await store.bindDiff({ repoPath: repo, base, reviewId: 'warm-up' });
    if (!warm.ok) throw new Error(`warm-up bind failed: ${JSON.stringify(warm)}`);
    store.flush();
    clock += 31 * MINUTE;
    await store.evictIdleDocs();
    expect(store.stats().residentDocs).toBe(0);
    const h0 = heapBytes();

    const bound = await store.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error(`bind failed: ${JSON.stringify(bound)}`);
    expect(store.stats().residentDocs).toBe(FILES);
    const hBound = heapBytes();

    // Two and a half hours of an agent working one file while the review
    // stays open: thirty ticks, five minutes apart.
    for (let n = 1; n <= 30; n++) await tick(bound.reviewId, n, 0);

    // The file being worked on stays; the thirty-nine nobody reached left.
    expect(store.stats().residentDocs).toBeLessThanOrEqual(2);
    // What the bind added (~40 × 176KB) is gone again once the evicted
    // docs' last timers have let go of them. Measured on the base commit,
    // which keeps all forty: 0.43 of it remains. With the fix: below zero.
    await waitFor(() => (heapBytes() - h0) / (hBound - h0) < 0.2, {
      interval: 250,
      describe: 'heap to fall back below a fifth of what the bind added',
    });
  }, 60_000);

  it('leaves unchanged members alone when the review was bound with groups and a file cap', async () => {
    // Agents are told to always pass groups, and a refresh replays them with
    // the bind-time config onto every member (`rememberWorkspaceConfig`).
    const bound = await store.bindDiff({
      repoPath: repo,
      base,
      groups: [{ title: 'Harborlight', paths: ['src'] }],
      maxFiles: 100,
    });
    if (!bound.ok) throw new Error(`bind failed: ${JSON.stringify(bound)}`);
    for (let n = 1; n <= 12; n++) await tick(bound.reviewId, n, 0);
    expect(store.stats().residentDocs).toBeLessThanOrEqual(2);
    const f3 = store.list().find((m) => m.docId === memberDocId(bound.reviewId, rel(3)));
    expect(f3?.diffGroup).toBe('Harborlight');
  }, 60_000);

  it('still refreshes a member that moved after it was evicted, and an evicted member opens on the current file', async () => {
    const bound = await store.bindDiff({ repoPath: repo, base });
    if (!bound.ok) throw new Error(`bind failed: ${JSON.stringify(bound)}`);
    for (let n = 1; n <= 8; n++) await tick(bound.reviewId, n, 0);
    const f1 = memberDocId(bound.reviewId, rel(1));
    const f2 = memberDocId(bound.reviewId, rel(2));
    expect(store.peek(f1)).toBeUndefined();
    expect(store.peek(f2)).toBeUndefined();

    // f1 moves while evicted: the refresh must write its new counts.
    writeFileSync(join(repo, rel(1)), `${body}// Riverbend 1\n// Saltmarsh\n// Saltmarsh\n`);
    const res = await store.refreshWorkspace(bound.reviewId);
    expect(res.ok).toBe(true);
    const moved = store.list().find((m) => m.docId === f1);
    expect(moved?.diffAdditions).toBe(3);

    // f2 changed on disk in a way the counts cannot see (same line count):
    // opening it must still show the file as it is now.
    writeFileSync(join(repo, rel(2)), `${body}// Alice 2\n`);
    const opened = store.get(f2);
    await waitFor(() => opened?.ydoc.getText('content').toString() === `${body}// Alice 2\n`, {
      describe: 'the evicted member to open on the current file',
    });
  }, 60_000);
});
