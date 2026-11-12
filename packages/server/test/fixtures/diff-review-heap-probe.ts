/**
 * Child-process fixture for diff-review-residency.test.ts: hold a live diff
 * review open across thirty refresh ticks and report what the heap did. Run
 * with `bun run`, never as a test. The heap is process-wide, so in the shared
 * suite process every other file's allocations land in the same figure; a
 * throwaway process is the only place the number belongs to this review.
 *
 * Prints one JSON line: `{ resident, h0, hBound, hAfter }` in MB — the heap
 * before the bind (after a warm-up bind has aged out), just after it, and
 * after the ticks.
 */
import { heapStats } from 'bun:jsc';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../../src/doc-store.ts';
import { SseBus } from '../../src/sse.ts';
import { createWebhookDispatcher } from '../../src/webhooks.ts';
import { waitFor } from '../wait-for.ts';

const MINUTE = 60_000;
const FILES = 40;

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();

const heapBytes = (): number => {
  Bun.gc(true);
  Bun.gc(true);
  return heapStats().heapSize;
};

/** The heap once evicted docs' last timers have let go of them: polled until
 *  two readings 100ms apart differ by under 64KB, rather than a fixed wait. */
async function settledHeap(): Promise<number> {
  let last = heapBytes();
  await waitFor(
    () => {
      const now = heapBytes();
      const settled = Math.abs(now - last) < 64 * 1024;
      last = now;
      return settled;
    },
    { interval: 100, timeout: 3000 },
  ).catch(() => {});
  return last;
}

let body = '';
for (let i = 0; body.length < 30_000; i++) {
  body += `export function harborlight${i}(x: number): number {\n  return x * ${i} + ${i};\n}\n\n`;
}
const rel = (i: number) => `src/f${i}.ts`;

const dataDir = mkdtempSync(join(tmpdir(), 'drh-data-'));
const repo = mkdtempSync(join(tmpdir(), 'drh-repo-'));
git(repo, 'init', '-q');
mkdirSync(join(repo, 'src'));
for (let i = 0; i < FILES; i++) writeFileSync(join(repo, rel(i)), body);
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'base');
const base = git(repo, 'rev-parse', 'HEAD');
for (let i = 0; i < FILES; i++) writeFileSync(join(repo, rel(i)), `${body}// Riverbend ${i}\n`);

let clock = Date.now();
const store = new DocStore({
  dataDir,
  sse: new SseBus(),
  webhooks: createWebhookDispatcher({ onLog: () => {} }),
  now: () => clock,
});

// Warm up under another review id and let it age out, so code the bind path
// compiles on first use is not counted as doc heap.
await store.bindDiff({ repoPath: repo, base, reviewId: 'warm-up' });
store.flush();
clock += 31 * MINUTE;
await store.evictIdleDocs();
const h0 = await settledHeap();

const bound = await store.bindDiff({ repoPath: repo, base });
if (!bound.ok) throw new Error(`bind failed: ${JSON.stringify(bound)}`);
const hBound = await settledHeap();

for (let n = 1; n <= 30; n++) {
  clock += 5 * MINUTE;
  writeFileSync(join(repo, rel(0)), `${body}// Riverbend 0\n${'// edit\n'.repeat(n)}`);
  const res = await store.refreshWorkspace(bound.reviewId);
  if (!res.ok) throw new Error(`refresh failed: ${JSON.stringify(res)}`);
  await store.evictIdleDocs();
}
store.flush();

const hAfter = await settledHeap();
const resident = store.stats().residentDocs;
store.stop();
rmSync(dataDir, { recursive: true, force: true });
rmSync(repo, { recursive: true, force: true });
const mb = (n: number) => Math.round(n / 1e5) / 10;
console.log(JSON.stringify({ resident, h0: mb(h0), hBound: mb(hBound), hAfter: mb(hAfter) }));
process.exit(0);
