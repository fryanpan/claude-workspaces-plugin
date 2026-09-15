/**
 * The verify lane — one expensive gate run on this machine at a time.
 *
 * WHY. This machine hosts several agents at once, and a whole-suite `bun run
 * verify` saturates it. Two runs overlapping do not merely take longer: they
 * change the ANSWER. The same suite measured 309s passing alone and 430s
 * failing under contention on 2026-09-10, so a red from a contended run says
 * nothing about the diff, which is the one thing the command exists to say.
 *
 * WHY A LOCK AND NOT A CONVENTION. The lane was held by agreement for a week
 * and the agreement failed twice in one hour on 2026-09-15, both times the
 * same way: a hold is sent as a message, a message reaches an agent between
 * turns, and a run that has already started does not read it. Serialising by
 * message cannot work — the request arrives after the decision is made. A
 * lock is read at the moment of the decision, which is the only moment that
 * can change it.
 *
 * WHY THIS FILE IS SHORT. The lock itself is `probe-lock.ts`, already in this
 * directory, and its header is the argument for why: a lock FILE cannot be
 * reclaimed safely from a dead holder, because "unlink it if it is still the
 * same lock" is not an operation POSIX has, and every narrowing of that race
 * leaves another. A listening socket is exclusive by the kernel's own
 * bookkeeping and is dropped the instant the holder exits — crash, SIGKILL or
 * clean release alike. So a run killed mid-lane frees the lane immediately,
 * with no staleness window to get wrong and nothing left on disk to go stale.
 * The first draft of this module was the lock file that header warns about.
 *
 * WHAT IS SHARED, AND ACROSS WHAT. The lane is a property of the MACHINE, and
 * every builder runs in its own worktree. `probeLockPort` hashes key + scope,
 * so a scope of "this working directory" would give each worktree a private
 * lane and serialise nothing — the exact failure this exists to stop, wearing
 * a green light. The scope is therefore the SHARED git directory, which every
 * worktree of this repo resolves to the same path and an unrelated checkout
 * does not.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProbeLock, probeLockPort } from './probe-lock.ts';

/** The lock key. One lane for this repo, whatever worktree asks for it. */
export const LANE_KEY = 'verify-lane';

/**
 * The members whose cost is the reason the lane exists.
 *
 * The lane is taken for a full run, and for a narrowed run that still asks
 * for one of these. Everything else — `lint`, `typecheck`, a single audit —
 * runs unserialised on purpose: they finish in seconds, they saturate
 * nothing, and making somebody queue behind a seven-minute suite to check
 * their own formatting would buy nothing while costing the fast iteration
 * that makes `--only` worth having.
 *
 * `check:meeting-smoke` sits with the three suites because it drives a real
 * server and a real browser, which is the same kind of load.
 */
export const HEAVY_MEMBERS: readonly string[] = [
  'test:vitest',
  'test:server',
  'coverage',
  'check:meeting-smoke',
];

/** Whether this selection is heavy enough to need the lane. */
export function needsLane(memberIds: readonly string[]): boolean {
  return memberIds.some((id) => HEAVY_MEMBERS.includes(id));
}

/**
 * What a holder writes down about itself, for the waiter's message only.
 *
 * ADVISORY, NEVER AUTHORITATIVE. The socket is the lock; this file exists so
 * a waiting run can say WHO it is behind and for how long, instead of "the
 * lane is busy". Nothing decides anything on it: a missing, stale or
 * unparseable note costs a waiter some detail in one line of output and
 * changes no behaviour, which is the only way a file may take part in a lock
 * whose whole point was to keep liveness out of the filesystem.
 */
export interface LaneNote {
  pid: number;
  startedAt: number;
  cwd: string;
}

export function laneNotePath(gitCommonDir: string): string {
  return join(gitCommonDir, 'verify-lane.note');
}

/** Read the note, or null for anything at all wrong with it. */
export function readLaneNote(path: string): LaneNote | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LaneNote>;
    if (typeof raw.pid !== 'number' || typeof raw.startedAt !== 'number') return null;
    return { pid: raw.pid, startedAt: raw.startedAt, cwd: String(raw.cwd ?? 'unknown') };
  } catch {
    return null;
  }
}

/** The line a waiting run prints, given whatever the note could tell it. */
export function waitingLine(note: LaneNote | null, now: number, port: number): string {
  if (note === null) {
    return `⏳ waiting for the verify lane (127.0.0.1:${port}) — another expensive gate run holds it.`;
  }
  return (
    `⏳ waiting for the verify lane — held by pid ${note.pid} in ${note.cwd}, ` +
    `running for ${humanSecs(now - note.startedAt)}.`
  );
}

export function humanSecs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}m ${total % 60}s` : `${total}s`;
}

/** `--git-common-dir` is relative in a primary checkout, absolute in a worktree. */
export function gitCommonDir(cwd: string): string | null {
  // node:child_process, not Bun.spawnSync: the colocated test runs under
  // vitest, where the Bun global does not exist and this would throw.
  const out = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' });
  if (out.status !== 0 || typeof out.stdout !== 'string') return null;
  const raw = out.stdout.trim();
  if (raw === '') return null;
  return raw.startsWith('/') ? raw : join(cwd, raw);
}

/**
 * Hold the lane for one run, and give back the only way to end it.
 *
 * A selection with nothing expensive in it takes no lock at all — `--only
 * lint` must not queue behind a suite. So must a checkout with no git dir to
 * scope the lane to: run unserialised rather than refuse, because a machine
 * with no repo has no second worktree to collide with.
 */
export async function enterLane(
  repoRoot: string,
  memberIds: readonly string[],
  log: (line: string) => void = console.log,
): Promise<(code: number) => never> {
  const exit = (code: number): never => process.exit(code);
  if (!needsLane(memberIds)) return exit;

  const common = gitCommonDir(repoRoot);
  if (common === null) return exit;

  const notePath = laneNotePath(common);
  const port = probeLockPort(LANE_KEY, common);
  const started = Date.now();

  // Announce BEFORE blocking, and only when somebody is actually in the way:
  // a run that prints nothing for seven minutes is indistinguishable from a
  // wedged one, and that ambiguity is what sends people to `kill -9`.
  const held = await someoneHolds(port);
  if (held) {
    log(waitingLine(readLaneNote(notePath), Date.now(), port));
    log('   One expensive gate run at a time: a red from two at once says nothing.');
    log('   Not waiting? Narrow the run — cheap members with --only take no lane.');
  }

  // An hour, not probe-lock's five minutes: the thing being waited for is a
  // whole gate suite, and timing out underneath one would hand back exactly
  // the unexplained red the lane exists to prevent.
  const lock = await acquireProbeLock(LANE_KEY, common, { timeoutMs: 60 * 60_000 });
  if (held) log(`▶ verify lane free after ${humanSecs(Date.now() - started)} — starting.`);

  writeNote(notePath, { pid: process.pid, startedAt: Date.now(), cwd: process.cwd() });

  const release = (): void => {
    rmSync(notePath, { force: true });
    lock.release();
  };
  // The kernel drops the socket on exit however this process dies, so these
  // handlers are only here to take the note with it. A note left behind is
  // read by nobody — `someoneHolds` asks the port, never the file.
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      release();
      process.exit(130);
    });
  }
  return (code: number): never => {
    release();
    process.exit(code);
  };
}

function writeNote(path: string, note: LaneNote): void {
  try {
    writeFileSync(path, JSON.stringify(note));
  } catch {
    // Diagnosis only. A note we cannot write costs a future waiter one line of
    // detail; it must never cost this run its lane.
  }
}

/** Is anybody on the lane port right now? Used only to decide whether to explain. */
async function someoneHolds(port: number): Promise<boolean> {
  const { createConnection } = await import('node:net');
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const done = (answer: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(500, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}
