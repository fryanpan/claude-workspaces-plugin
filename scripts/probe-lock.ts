/**
 * A cross-process mutex for tests that plant files in the shared checkout.
 *
 * `scripts/test-audit.test.ts` proves the audit by writing probe files into the
 * real tree and reading the count back. That makes the whole working tree the
 * test's fixture, and two `bun run test:vitest` runs in one worktree - a lead's
 * `verify` and a builder's, which is the normal state of this machine - then
 * race three ways at once: one run's `afterEach` deletes the other's probe
 * (`ENOENT` out of `rmSync`), one run's planted probes are counted by the
 * other's audit (`source-shape reads 20 baseline 12 OVER`), and the "nothing is
 * named before I plant" control sees the other run's sites. CI never sees it:
 * each shard gets its own checkout.
 *
 * Unique probe names fix the deletion, but not the counting - two runs cannot
 * both make a count assertion about one tree - so the plant/measure/clean
 * window has to be exclusive.
 *
 * ## Why a socket and not a lock file
 *
 * The first cut of this module was a lock file: `open(path, 'wx')` to take it,
 * `unlink` to release, and an mtime check to reclaim one whose holder had died.
 * That reclaim is a check-then-unlink race, and it is not a narrow one to be
 * tightened - it cannot be closed. If the holder releases between the staleness
 * check and the unlink, the unlink destroys whatever lock now sits at that
 * path, and two runs enter the window. Renaming the file to a private name
 * before deleting it, so that a stranger's lock is never the thing unlinked,
 * removes one outcome and leaves another: the rename itself can carry off a
 * live lock, and restoring it needs the path to still be free, which no POSIX
 * operation can guarantee. There is no "unlink if this is still the same
 * inode".
 *
 * So liveness is not tracked in the filesystem at all. A listening socket on
 * loopback is exclusive by the kernel's own bookkeeping, and the kernel drops
 * it the instant the holder exits - crash, `SIGKILL`, or a clean release alike.
 * That deletes the staleness window rather than shortening it, and with it
 * every line of reclaim logic: a dead holder frees the lock immediately instead
 * of after a timeout, and nothing is ever left on disk to go stale.
 *
 * Nothing is served on the socket and no connection is ever accepted; the bind
 * IS the lock. It listens on `127.0.0.1` only, so it is unreachable off the
 * machine.
 */
import { createHash } from 'node:crypto';
import { type Server, createServer } from 'node:net';

/**
 * The port range the rendezvous hashes into.
 *
 * Above everything this repo reserves (8787 for prod, 8788 for staging) and
 * well below macOS's ephemeral range, which starts at 49152 - a port in there
 * would be taken out from under us by any outbound connection on the machine
 * and read as a held lock.
 */
const PORT_BASE = 8900;
const PORT_SPAN = 100;

/** How long to keep trying before giving up rather than hanging the suite. */
const TIMEOUT_MS = 300_000;
/** Gap between attempts. Short: the guarded window is a few audit runs long. */
const RETRY_MS = 50;

export interface ProbeLock {
  /** The port the bind holds, so a test can assert on the real artifact. */
  readonly port: number;
  /** Idempotent. The kernel does the same thing if the process just exits. */
  release(): void;
}

/**
 * One port per key per checkout, so two different lock keys - and the same key
 * in two different worktrees - never wait on each other.
 */
export function probeLockPort(key: string, scope: string): number {
  const digest = createHash('sha1').update(`${key} ${scope}`).digest();
  return PORT_BASE + (digest.readUInt16BE(0) % PORT_SPAN);
}

/** Resolves to the listening server, or null if somebody else holds the port. */
function tryListen(port: number): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    // Never keep the process alive on the lock's account: a run that finishes
    // while still holding it should exit, and exiting is what releases it.
    server.unref();
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(server);
    };
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') resolve(null);
      else reject(err);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(port, '127.0.0.1');
  });
}

export interface AcquireOptions {
  /** Overrides the default deadline; a test proving contention wants a short one. */
  timeoutMs?: number;
}

/**
 * Blocks until this process holds `key` for `scope`, then hands back the
 * release.
 */
export async function acquireProbeLock(
  key: string,
  scope: string,
  options: AcquireOptions = {},
): Promise<ProbeLock> {
  const port = probeLockPort(key, scope);
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const server = await tryListen(port);
    if (server) {
      let open = true;
      return {
        port,
        release(): void {
          if (!open) return;
          open = false;
          server.close();
        },
      };
    }
    if (Date.now() > deadline) {
      // Name the port: the one way this waits forever is a process that is not
      // one of ours sitting on it, and that is what somebody has to go look at.
      throw new Error(
        `probe lock ${key} (127.0.0.1:${port}) still held after ${timeoutMs}ms - ` +
          `check with: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}
