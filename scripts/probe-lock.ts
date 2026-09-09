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
 * of after a timeout, and nothing is left on disk to go stale.
 *
 * The bind IS the lock. A connection is answered with one line naming the key
 * the holder took and then closed, which is used for diagnosis only - see
 * `identifyHolder`. Everything listens on `127.0.0.1`, so none of it is
 * reachable off the machine.
 */
import { createHash } from 'node:crypto';
import { type Server, type Socket, createConnection, createServer } from 'node:net';

/**
 * The port range the rendezvous hashes into.
 *
 * Above everything this repo reserves (8787 for prod, 8788 for staging) and
 * well below macOS's ephemeral range, which starts at 49152 - a port in there
 * would be taken out from under us by any outbound connection on the machine
 * and read as a held lock.
 *
 * The span is wide because two identities landing on one port is not an error
 * that can be resolved by moving to the next free port: which port is free
 * depends on who happens to be holding what, so a probing fallback would let
 * two runs of the SAME identity settle on two different ports and both believe
 * they hold it. Colliding identities therefore share a port and simply take
 * turns, which costs a little serialisation and never correctness. Twenty
 * thousand ports keeps that rare, and `identifyHolder` makes it legible when it
 * does happen.
 */
const PORT_BASE = 8900;
const PORT_SPAN = 20_000;

/** How long to keep trying before giving up rather than hanging the suite. */
const TIMEOUT_MS = 300_000;
/** Gap between attempts. Short: the guarded window is a few audit runs long. */
const RETRY_MS = 50;
/** Long enough for a loopback round trip, short enough not to add a stall. */
const HELLO_MS = 500;

/** The greeting a holder answers with, so a waiter can name who is in the way. */
const HELLO_PREFIX = 'probe-lock ';

/**
 * Ports this process is holding, and under which key.
 *
 * Waiting on a lock your own process holds can never succeed, so it is a
 * deadlock dressed up as a timeout. That happens two ways: acquiring the same
 * key twice without releasing, and two different identities colliding onto one
 * port inside one process. Both are caught here and fail immediately with a
 * message that says which, instead of stalling for five minutes.
 */
const heldHere = new Map<number, string>();

export interface ProbeLock {
  /** The port the bind holds, so a test can assert on the real artifact. */
  readonly port: number;
  /** Idempotent. The kernel does the same thing if the process just exits. */
  release(): void;
}

/**
 * One port per key per checkout, so two different lock keys - and the same key
 * in two different worktrees - almost never wait on each other.
 */
export function probeLockPort(key: string, scope: string): number {
  const digest = createHash('sha1').update(`${key} ${scope}`).digest();
  return PORT_BASE + (digest.readUInt32BE(0) % PORT_SPAN);
}

/** Resolves to the listening server, or null if somebody else holds the port. */
function tryListen(port: number, key: string): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      // Diagnosis only. Nothing is read, and the answer decides nothing.
      socket.unref();
      socket.on('error', () => {});
      socket.end(`${HELLO_PREFIX}${key}\n`);
    });
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

/**
 * Asks whoever holds the port to say what they are, for the timeout message.
 *
 * A lock that never comes free is almost always an unrelated service sitting on
 * the port, and "something is listening" is not a useful thing to hand somebody
 * at 3am. Resolves to null when nobody answers in the shape we speak.
 */
export function identifyHolder(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    let seen = '';
    const done = (value: string | null): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.unref();
    const timer = setTimeout(() => done(null), HELLO_MS);
    timer.unref?.();
    socket.on('data', (chunk) => {
      seen += String(chunk);
      if (seen.includes('\n')) {
        const line = seen.slice(0, seen.indexOf('\n'));
        done(line.startsWith(HELLO_PREFIX) ? line.slice(HELLO_PREFIX.length) : null);
      }
    });
    socket.on('end', () =>
      done(seen.startsWith(HELLO_PREFIX) ? seen.slice(HELLO_PREFIX.length).trim() : null),
    );
    socket.on('error', () => done(null));
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
  const mine = heldHere.get(port);
  if (mine !== undefined) {
    throw new Error(
      mine === key
        ? `probe lock ${key} is already held by this process - release it before taking it again`
        : `probe lock ${key} collides on port ${port} with ${mine}, already held by this process`,
    );
  }

  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const server = await tryListen(port, key);
    if (server) {
      heldHere.set(port, key);
      let open = true;
      return {
        port,
        release(): void {
          if (!open) return;
          open = false;
          heldHere.delete(port);
          server.close();
        },
      };
    }
    if (Date.now() > deadline) {
      const holder = await identifyHolder(port);
      throw new Error(
        `probe lock ${key} (127.0.0.1:${port}) still held after ${timeoutMs}ms by ` +
          `${holder === null ? 'something that is not a probe lock' : `the lock ${holder}`} - ` +
          `check with: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

export interface WindowSteps {
  /** Runs after the lock is taken, before the guarded work. */
  enter?: () => void | Promise<void>;
  /** Runs while the lock is STILL held, before it is let go. */
  leave?: () => void | Promise<void>;
}

export interface ExclusiveWindow {
  /** Takes the lock, then runs `enter` inside it. */
  open(): Promise<void>;
  /** Runs `leave` inside the lock, then releases it whatever `leave` did. */
  close(): Promise<void>;
}

/**
 * The lock and the work it guards as one object, because the ordering between
 * them is the part that gets broken.
 *
 * A test suite naturally writes this as two `afterEach` hooks - clean up, then
 * release - and then the ordering lives in the runner's hook policy rather than
 * in anything the file says. On vitest 3.2.7 `sequence.hooks` defaults to
 * `stack`, so registering the release first does put the cleanup ahead of it;
 * set `sequence.hooks` to `parallel` or `list` in the config and that silently
 * inverts, and the release lands while the cleanup is still deleting probes.
 * Nobody would connect a config change to a flaky audit gate.
 *
 * So `close()` owns the order: `leave` finishes first, and the release is in a
 * `finally` so a throwing cleanup still lets the next run in.
 */
export function exclusiveWindow(
  key: string,
  scope: string,
  steps: WindowSteps,
  options: AcquireOptions = {},
): ExclusiveWindow {
  let lock: ProbeLock | undefined;
  return {
    async open(): Promise<void> {
      lock = await acquireProbeLock(key, scope, options);
      try {
        await steps.enter?.();
      } catch (err) {
        lock.release();
        lock = undefined;
        throw err;
      }
    },
    async close(): Promise<void> {
      try {
        await steps.leave?.();
      } finally {
        lock?.release();
        lock = undefined;
      }
    },
  };
}
