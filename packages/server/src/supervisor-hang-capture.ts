/**
 * What the supervisor records about a hung server before it restarts it.
 *
 * On 27 October prod hung twice, at 17:35Z and 21:49Z, and each time the err
 * log said only `no reply within 10000ms`. The server's own `[loop] blocked`
 * line (`event-loop.ts`) is written when a block ENDS, and the restart kills
 * the process first, so the one hang that matters is the one that never gets
 * a line. The lines before the second hang named nothing in flight, with page
 * faults climbing and little CPU, on a machine using 7.9 of its 9.2 GB of
 * swap — memory pressure is the leading guess, and nothing on record shows it.
 *
 * So, between the second failed probe and the restart, the supervisor takes:
 *
 *   - a stack sample of the server (`sample <pid> 2 -mayDie`), written to a
 *     file under the data directory, with its path logged;
 *   - `vm.swapusage` and `memory_pressure -Q`'s free percentage;
 *   - the server's RSS and `ps` state, and its page-in count from `top`.
 *
 * What the main thread was doing is NOT among them. The in-flight requests and
 * background passes live in `InflightRegistry`, in the server's memory, and
 * the only thread that could hand them out is the one that is stuck. The log
 * line says so, so a reader does not go looking for it.
 *
 * Every command runs at once under one bound. A capture is evidence about a
 * restart, never a reason to delay one: `createHealthWatchdog` also races the
 * whole capture against `HANG_CAPTURE_BUDGET_MS`, so a runner that ignores its
 * own timeout still cannot hold the restart.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** The most the capture may add to a restart. */
export const HANG_CAPTURE_BUDGET_MS = 6_000;
/**
 * Each command's own timeout. A second under the budget, so a command that
 * runs out is logged as timed out before the watchdog gives up on the whole
 * capture.
 */
export const HANG_COMMAND_TIMEOUT_MS = HANG_CAPTURE_BUDGET_MS - 1_000;
/** How long `sample` watches. Its symbol pass runs after, inside the budget. */
export const HANG_SAMPLE_SECONDS = 2;
/** Older sample files are transient diagnostics; keep this many. */
export const HANG_SAMPLES_KEPT = 10;
/** The directory under the data dir the sample files go in. */
export const HANG_CAPTURE_DIR = 'supervisor-hang';

export interface CommandResult {
  stdout: string;
  /** null when the command was killed or never ran. */
  code: number | null;
  timedOut?: boolean;
}

/** Runs one command. Must resolve, never reject, by `timeoutMs`. */
export type RunCommand = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<CommandResult>;

export interface HangCaptureDeps {
  /** The server child's pid. Without one only the machine is read. */
  pid: number | undefined;
  /** The data directory; samples go in `HANG_CAPTURE_DIR` under it. */
  dataDir: string;
  run: RunCommand;
  log: (line: string) => void;
  now?: () => number;
  timeoutMs?: number;
}

/** `vm.swapusage: total = 9216.00M  used = 7873.38M ...` → `used 7873.38M of 9216.00M`. */
export function parseSwap(stdout: string): string | null {
  const total = /total = ([\d.]+\w)/.exec(stdout)?.[1];
  const used = /used = ([\d.]+\w)/.exec(stdout)?.[1];
  return total && used ? `used ${used} of ${total}` : null;
}

/** `memory_pressure -Q` → the free percentage, e.g. `45%`. */
export function parseMemoryFree(stdout: string): string | null {
  return /free percentage:\s*(\d+%)/.exec(stdout)?.[1] ?? null;
}

/** `ps -o rss=,stat=` → RSS in MB and the state column. */
export function parsePs(stdout: string): { rssMb: number; state: string } | null {
  const m = /^\s*(\d+)\s+(\S+)/.exec(stdout);
  return m ? { rssMb: Math.round(Number(m[1]) / 1024), state: m[2] as string } : null;
}

/** `top -l 1 -pid <pid> -stats pid,pageins,faults` → the row for that pid. */
export function parseTop(stdout: string, pid: number): { pageins: number; faults: number } | null {
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (m && Number(m[1]) === pid) return { pageins: Number(m[2]), faults: Number(m[3]) };
  }
  return null;
}

function failed(r: CommandResult): string {
  return r.timedOut ? 'timed out' : `exit ${r.code ?? 'killed'}`;
}

/** Deletes all but the newest `keep - 1` samples, so the new one makes `keep`. */
function pruneSamples(dir: string, keep: number): void {
  const old = readdirSync(dir)
    .filter((f) => f.startsWith('sample-') && f.endsWith('.txt'))
    .sort();
  for (const f of old.slice(0, Math.max(0, old.length - (keep - 1)))) {
    rmSync(join(dir, f), { force: true });
  }
}

/**
 * Takes every reading at once and logs one line per reading. Never rejects:
 * a reading that fails logs why, and the rest still land.
 */
export async function captureHang(deps: HangCaptureDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? HANG_COMMAND_TIMEOUT_MS;
  const { pid, run, log } = deps;
  const tag = '[supervisor] hang capture:';
  // A runner that throws synchronously is caught too, so one bad reading
  // cannot take the others with it.
  const safe = (call: () => Promise<CommandResult>): Promise<CommandResult> =>
    Promise.resolve()
      .then(call)
      .catch((): CommandResult => ({ stdout: '', code: null }));

  let samplePath: string | null = null;
  if (pid !== undefined) {
    try {
      const dir = join(deps.dataDir, HANG_CAPTURE_DIR);
      mkdirSync(dir, { recursive: true });
      pruneSamples(dir, HANG_SAMPLES_KEPT);
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      samplePath = join(dir, `sample-${stamp}-pid${pid}.txt`);
    } catch (err) {
      log(`${tag} no sample — could not prepare its directory (${String(err)})`);
    }
  }

  const opts = { timeoutMs };
  const [sample, swap, pressure, ps, top] = await Promise.all([
    pid !== undefined && samplePath
      ? safe(() =>
          run(
            'sample',
            [String(pid), String(HANG_SAMPLE_SECONDS), '-mayDie', '-file', samplePath],
            opts,
          ),
        )
      : null,
    safe(() => run('sysctl', ['vm.swapusage'], opts)),
    safe(() => run('memory_pressure', ['-Q'], opts)),
    pid !== undefined ? safe(() => run('ps', ['-o', 'rss=,stat=', '-p', String(pid)], opts)) : null,
    pid !== undefined
      ? safe(() =>
          run('top', ['-l', '1', '-pid', String(pid), '-stats', 'pid,pageins,faults'], opts),
        )
      : null,
  ]);

  if (sample && samplePath) {
    log(
      sample.code === 0
        ? `${tag} stack sample of pid ${pid} written to ${samplePath}`
        : `${tag} stack sample of pid ${pid} failed (${failed(sample)}); expected at ${samplePath}`,
    );
  }
  const swapText = swap.code === 0 ? parseSwap(swap.stdout) : null;
  const freeText = pressure.code === 0 ? parseMemoryFree(pressure.stdout) : null;
  log(
    `${tag} machine — swap ${swapText ?? `unread (${failed(swap)})`}, ` +
      `memory free ${freeText ?? `unread (${failed(pressure)})`}`,
  );
  if (pid !== undefined) {
    const psRow = ps && ps.code === 0 ? parsePs(ps.stdout) : null;
    const topRow = top && top.code === 0 ? parseTop(top.stdout, pid) : null;
    log(
      `${tag} server pid ${pid} — ` +
        (psRow ? `RSS ${psRow.rssMb}MB, ps state ${psRow.state}` : 'RSS unread') +
        ', ' +
        (topRow ? `${topRow.pageins} page-ins, ${topRow.faults} faults` : 'page-ins unread'),
    );
  }
  log(
    `${tag} what the main thread was running is not readable from here — the in-flight list ` +
      "lives in the server's memory and only its stuck thread can hand it out; read the sample",
  );
}

/**
 * The real runner: spawns, keeps at most 64KB of stdout, SIGKILLs at the
 * timeout. Resolves on `close` or the timeout, whichever comes first.
 */
export const spawnCommand: RunCommand = (cmd, args, { timeoutMs }) =>
  new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (r: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ stdout, code: null, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString('utf8');
    });
    child.once('error', () => finish({ stdout, code: null }));
    child.once('close', (code) => finish({ stdout, code }));
  });
