/**
 * What stops a throwaway headless Chrome outliving the process that launched it
 * when that process never gets to run its own cleanup.
 *
 * `scripts/headless-chrome.ts` removes the browser on success, on a throw and
 * on SIGINT/SIGTERM/SIGHUP. None of that runs when the parent is SIGKILLed — a
 * Bash tool timeout, a stopped agent — or when a caller throws before it has
 * registered the browser. Chrome is then reparented to pid 1 and runs until
 * somebody notices: nine were found 15 hours to 2 days old (54 processes,
 * ~1.2 GB) on 2026-09-14, and a SIGKILLed `ui:shot` reproduces one every time.
 *
 * Two mechanisms, because each covers what the other cannot:
 *
 *   - **A watchdog per launch.** A detached `/bin/sh` loop polls the parent's
 *     pid once a second; when the parent is gone it kills Chrome and removes
 *     the profile. Detached, so a signal to the parent's process group does not
 *     take it down with the parent. Its arguments travel in the environment, so
 *     nothing matching `--user-data-dir=` in `ps` is the watchdog. The owner's
 *     own cleanup stops it first, so a finished run leaves no shell behind.
 *   - **A reaper on the first launch in a process**, for an orphan whose
 *     watchdog also died (or that predates watchdogs). It kills ONLY a process
 *     that runs headless, names a `cw-ui-shot-*` profile directly under this
 *     process's temp dir, has pid 1 as its parent, and is older than
 *     `ORPHAN_REAP_AGE_MS`. A live run's Chrome is parented to that run, never
 *     to pid 1, so no live run's browser can match; the age floor keeps the
 *     reaper from racing a watchdog that is mid-cleanup.
 *
 * Why not Chrome watching its parent itself: headless Chrome has no flag for
 * it on macOS, and a pipe-based check would need every launcher to hold the
 * pipe open. A shell loop needs nothing from Chrome.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { PROFILE_PREFIX } from './ui-shot-lib.ts';

/**
 * Ten minutes. The watchdog clears a fresh orphan within about a second, so
 * anything the reaper sees is one nothing else will ever clean; ten minutes is
 * far past the longest legitimate launch (two 30s startups plus a page
 * ceiling), so the floor never has to be argued case by case.
 */
export const ORPHAN_REAP_AGE_MS = 10 * 60 * 1000;

const WATCHDOG_SCRIPT = `
p="$CW_WATCH_PARENT"; c="$CW_WATCH_CHROME"; d="$CW_WATCH_PROFILE"
case "$d" in */${PROFILE_PREFIX}*) ;; *) exit 0 ;; esac
while kill -0 "$p" 2>/dev/null; do sleep 1; done
case "$(ps -o command= -p "$c" 2>/dev/null)" in
  *"--user-data-dir=$d"*) kill -9 "$c" 2>/dev/null ;;
esac
i=0
while kill -0 "$c" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
rm -rf "$d"; sleep 0.2; rm -rf "$d"
`;

const watchdogs = new Map<number, ChildProcess>();

/**
 * Set to `0` to launch without a watchdog. For tests only: the owner's own
 * cleanup has to be proven on its own, and with a watchdog running a broken
 * cleanup still passes about a second later.
 */
export const WATCHDOG_ENV = 'CW_CHROME_WATCHDOG';

/** Start the watchdog for one launched Chrome. A no-op where there is no `/bin/sh`. */
export function startWatchdog(chrome: ChildProcess, profile: string): void {
  if (chrome.pid === undefined || process.platform === 'win32') return;
  if (process.env[WATCHDOG_ENV] === '0') return;
  const dog = spawn('/bin/sh', ['-c', WATCHDOG_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      CW_WATCH_PARENT: String(process.pid),
      CW_WATCH_CHROME: String(chrome.pid),
      CW_WATCH_PROFILE: profile,
    },
  });
  dog.on('error', () => {});
  dog.unref();
  watchdogs.set(chrome.pid, dog);
}

/** The watchdog's pid for one Chrome, while it has one. */
export function watchdogPid(chrome: ChildProcess): number | undefined {
  return chrome.pid === undefined ? undefined : watchdogs.get(chrome.pid)?.pid;
}

/** Stop the watchdog for a Chrome its owner is cleaning up itself. */
export function stopWatchdog(chrome: ChildProcess | undefined): void {
  const pid = chrome?.pid;
  if (pid === undefined) return;
  const dog = watchdogs.get(pid);
  watchdogs.delete(pid);
  if (dog?.pid === undefined) return;
  try {
    // Detached makes it a group leader: the group takes its `sleep` too.
    process.kill(-dog.pid, 'SIGKILL');
  } catch {}
}

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in ms; NaN when it does not parse. */
export function parseEtime(raw: string): number {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(raw.trim());
  if (!m) return Number.NaN;
  const [, dd = '0', hh = '0', mm = '0', ss = '0'] = m;
  return (((Number(dd) * 24 + Number(hh)) * 60 + Number(mm)) * 60 + Number(ss)) * 1000;
}

export interface Orphan {
  pid: number;
  profile: string;
  ageMs: number;
}

export interface OrphanMatch {
  /** Default `ORPHAN_REAP_AGE_MS`. */
  minAgeMs?: number;
  /** The directory a profile must sit directly in. Default: this process's `tmpdir()`. */
  root?: string;
}

/**
 * The orphaned throwaway Chromes in one `ps -Ao pid=,ppid=,etime=,command=`
 * listing: parent pid 1, headless, a `cw-ui-shot-*` profile directly under
 * `root`, and at least `minAgeMs` old. `root` is what keeps a test that
 * lowers the age floor inside its own temp dir.
 */
export function findOrphans(psOutput: string, opts: OrphanMatch = {}): Orphan[] {
  const minAgeMs = opts.minAgeMs ?? ORPHAN_REAP_AGE_MS;
  const root = resolve(opts.root ?? tmpdir());
  const out: Orphan[] = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, ppid, etime, command = ''] = m;
    if (Number(ppid) !== 1 || !command.includes('--headless')) continue;
    const profile = /--user-data-dir=(\S+)/.exec(command)?.[1];
    if (!profile) continue;
    if (resolve(dirname(profile)) !== root || !basename(profile).startsWith(PROFILE_PREFIX)) {
      continue;
    }
    const ageMs = parseEtime(etime ?? '');
    if (!(ageMs >= minAgeMs)) continue;
    out.push({ pid: Number(pid), profile, ageMs });
  }
  return out;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listProcesses(): string {
  const ps = spawnSync('ps', ['-Ao', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' });
  return ps.status === 0 ? ps.stdout : '';
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Kill every orphan `findOrphans` names and remove its profile. Returns what it
 * reaped. Skipped when this process IS pid 1 (a container entrypoint), where
 * "parent is pid 1" would describe this process's own live children.
 */
export function reapOrphanedChromes(
  opts: OrphanMatch & {
    log?: (msg: string) => void;
    /** The `ps` listing; injectable so a test can name its own stand-in. */
    listProcesses?: () => string;
  } = {},
): Orphan[] {
  if (process.platform === 'win32' || process.pid === 1) return [];
  const listing = (opts.listProcesses ?? listProcesses)();
  const orphans = findOrphans(listing, opts);
  for (const o of orphans) {
    try {
      process.kill(o.pid, 'SIGKILL');
    } catch {}
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isAlive(o.pid)) sleepSync(20);
    rmSync(o.profile, { recursive: true, force: true });
    if (existsSync(o.profile)) {
      sleepSync(200);
      rmSync(o.profile, { recursive: true, force: true });
    }
    opts.log?.(
      `reaped orphaned headless Chrome pid ${o.pid} (${basename(o.profile)}, ${Math.floor(o.ageMs / 60_000)} min old)`,
    );
  }
  return orphans;
}
