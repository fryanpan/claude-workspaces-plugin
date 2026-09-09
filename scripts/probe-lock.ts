/**
 * A cross-process mutex for tests that plant files in the shared checkout.
 *
 * `scripts/test-audit.test.ts` proves the audit by writing probe files into the
 * real tree and reading the count back. That makes the whole working tree the
 * test's fixture, and two `bun run test:vitest` runs in one worktree — a lead's
 * `verify` and a builder's, which is the normal state of this machine — then
 * race three ways at once: one run's `afterEach` deletes the other's probe
 * (`ENOENT` out of `rmSync`), one run's planted probes are counted by the
 * other's audit (`source-shape reads 20 baseline 12 OVER`), and the "nothing is
 * named before I plant" control sees the other run's sites. CI never sees it:
 * each shard gets its own checkout.
 *
 * Unique probe names fix the deletion, but not the counting — two runs cannot
 * both make a count assertion about one tree. So the plant/measure/clean window
 * is exclusive, and the lock lives in the OS temp dir rather than the repo so
 * that the file guarding the audit is not itself something the audit
 * enumerates.
 *
 * Holding it means no other run has probes planted, which is what makes a
 * leftover from an interrupted run unambiguous: under the lock, anything still
 * lying around is by definition nobody's.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Held longer than this, a lock is assumed to belong to a dead run. */
const STALE_MS = 120_000;
/** How long to keep trying before giving up rather than hanging the suite. */
const TIMEOUT_MS = 300_000;
/** Gap between attempts. Short: the guarded window is a few audit runs long. */
const RETRY_MS = 50;

export interface ProbeLock {
  /** The path of the lock file, so a test can assert on the real artifact. */
  readonly path: string;
  /** Idempotent, and never removes a lock some other run has since taken. */
  release(): void;
}

/** One lock file per key per checkout, in a directory no gate enumerates. */
export function probeLockPath(key: string, scope: string): string {
  const digest = createHash('sha1').update(scope).digest('hex').slice(0, 12);
  return join(tmpdir(), `cw-probe-lock-${key}-${digest}.lock`);
}

function readToken(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Reclaim a lock whose holder is gone, so one crash cannot wedge the suite. */
function clearIfStale(path: string): void {
  try {
    if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { force: true });
  } catch {
    // Vanished between the two calls — somebody else released it. Fine.
  }
}

export interface AcquireOptions {
  /** Overrides the default deadline; a test proving contention wants a short one. */
  timeoutMs?: number;
}

/**
 * Blocks until this process holds `key` for `scope`, then hands back the
 * release. Async because the wait has to yield: vitest runs these tests in a
 * worker, and a spin loop would starve the process the lock is waiting on.
 */
export async function acquireProbeLock(
  key: string,
  scope: string,
  options: AcquireOptions = {},
): Promise<ProbeLock> {
  const path = probeLockPath(key, scope);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + (options.timeoutMs ?? TIMEOUT_MS);

  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, token);
      closeSync(fd);
      return {
        path,
        release(): void {
          // Only ours. A stale-reclaim may have handed it to somebody else.
          if (readToken(path) === token) rmSync(path, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      clearIfStale(path);
      if (Date.now() > deadline) {
        throw new Error(`probe lock ${path} still held after ${options.timeoutMs ?? TIMEOUT_MS}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}
