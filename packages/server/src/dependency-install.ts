/**
 * `bun install --frozen-lockfile` in a deploy source, and the rule for what a
 * failed one means: nothing boots over it, and it is not retried in a loop.
 *
 * Two callers, one runner. The deploy verb (`deploy.ts`) installs before every
 * restart it schedules and answers `install-failed` when the install does not
 * succeed. The supervisor (`scripts/serve.ts --no-watch`) installs before it
 * builds a client or spawns a server, because the manual fallback — `git pull`
 * plus `launchctl kickstart`, used when the server is down and the verb cannot
 * answer — never reaches the verb. On 2026-08-30 a PR added a package and the
 * server booted into a missing-import crash; before this module the fallback
 * could still do exactly that, and only a person remembering to run the install
 * by hand stood in the way.
 *
 * Frozen, in both places, because a deploy installs exactly what was merged:
 * an install that wants to rewrite `bun.lock` is a broken merge to refuse
 * loudly, and a write to the lockfile would also dirty the deploy source,
 * which the NEXT deploy then refuses over. Only `node_modules` moves.
 *
 * Unconditional, in both places, rather than gated on `bun.lock` changing:
 * gating misses a pull whose install failed (the next attempt sees nothing new
 * to pull) and a checkout somebody updated by hand. A no-op frozen install
 * measured ~40-60ms against ~630 packages, next to a client build of seconds,
 * so the check is cheaper than any cache that could skip it. The one thing
 * that IS remembered is failure — see `installBeforeBoot`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Ceiling on `bun install`. A cold cache pulling a new package over a slow
 *  link is minutes, not seconds; a hang past this is a failed install, and a
 *  failed install is a refused restart — never a restart into missing
 *  imports. */
export const INSTALL_TIMEOUT_MS = 300_000;

/** What an install said. `detail` is the tail of bun's output on failure. */
export interface InstallResult {
  ok: boolean;
  detail?: string;
}

export type InstallRunner = () => InstallResult;

/** The real runner: `bun install --frozen-lockfile` in `cwd`, synchronously. */
export function spawnBunInstall(cwd: string): InstallRunner {
  return () => {
    try {
      const r = spawnSync('bun', ['install', '--frozen-lockfile'], {
        cwd,
        encoding: 'utf8',
        timeout: INSTALL_TIMEOUT_MS,
      });
      if (r.status === 0) return { ok: true };
      // The tail, not the head: bun prints its resolution log first and the
      // reason it stopped last.
      const tail = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.trim().slice(-500);
      return { ok: false, detail: tail || `bun install exited with ${r.status ?? 'a signal'}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  };
}

/**
 * Everything bun reads to decide what to install, hashed: the lockfile, the
 * root manifest, and each workspace manifest the root names. A fix to any of
 * them is a new question and earns an immediate attempt; the same inputs
 * failing again earn a backoff. An unreadable file hashes as absent rather
 * than throwing, so a missing lockfile is a fingerprint like any other.
 */
export function lockFingerprint(repoRoot: string): string {
  const read = (rel: string): string => {
    try {
      return readFileSync(join(repoRoot, rel), 'utf8');
    } catch {
      return '<absent>';
    }
  };
  const files = ['bun.lock', 'package.json'];
  let workspaces: unknown = [];
  try {
    workspaces = (JSON.parse(read('package.json')) as { workspaces?: unknown }).workspaces;
  } catch {}
  for (const pattern of Array.isArray(workspaces) ? workspaces : []) {
    if (typeof pattern !== 'string') continue;
    // This repo's shapes: `dir/*` and a literal directory. Anything richer
    // would be missed here and only cost a retry that waits out its backoff.
    const parent = pattern.endsWith('/*') ? pattern.slice(0, -2) : null;
    const rels = parent ? listDirs(join(repoRoot, parent)).map((d) => join(parent, d)) : [pattern];
    for (const rel of rels.sort()) files.push(join(rel, 'package.json'));
  }
  const hash = createHash('sha256');
  for (const rel of files) hash.update(`${rel}\0${read(rel)}\0`);
  return hash.digest('hex');
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** The last failed install, kept so a relaunch does not retry it at once. */
export interface InstallFailure {
  fingerprint: string;
  /** Consecutive failures against this fingerprint. */
  failures: number;
  lastAttemptAt: number;
  detail: string;
}

export interface InstallLedger {
  load(): InstallFailure | null;
  /** `null` clears it — the install succeeded. */
  save(failure: InstallFailure | null): void;
}

export function installLedgerPath(dataDir: string): string {
  return join(dataDir, 'supervisor-install-failure.json');
}

/**
 * The ledger as a JSON file. Unreadable reads as empty — the gate fails OPEN
 * to an attempt, because a ledger nobody can read must not hold prod down.
 * The in-process backoff does not depend on it: see `installBeforeBoot`.
 */
export function fileInstallLedger(path: string): InstallLedger {
  return {
    load() {
      try {
        const f = JSON.parse(readFileSync(path, 'utf8')) as Partial<InstallFailure>;
        if (typeof f.fingerprint !== 'string' || typeof f.failures !== 'number') return null;
        if (typeof f.lastAttemptAt !== 'number') return null;
        return { ...(f as InstallFailure), detail: String(f.detail ?? '') };
      } catch {
        return null;
      }
    },
    save(failure) {
      try {
        if (failure === null) {
          if (existsSync(path)) rmSync(path, { force: true });
          return;
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(`${path}.tmp`, JSON.stringify(failure, null, 2));
        renameSync(`${path}.tmp`, path);
      } catch {
        // Best effort: the running supervisor keeps its own copy.
      }
    },
  };
}

/** First retry after one minute, doubling, never more than 30 minutes apart:
 *  six attempts in the first hour of a failure that never clears, where a
 *  bare exit under launchd's 10s ThrottleInterval would make ~360. */
export const INSTALL_BACKOFF = { baseMs: 60_000, capMs: 30 * 60_000, pollMs: 5_000 };

export function installRetryDelayMs(failures: number, backoff = INSTALL_BACKOFF): number {
  return Math.min(backoff.capMs, backoff.baseMs * 2 ** Math.max(0, failures - 1));
}

export interface InstallGateDeps {
  install: InstallRunner;
  fingerprint: () => string;
  ledger: InstallLedger;
  /** Named in the log, so a person can clear the backoff by hand. */
  ledgerPath: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  backoff?: typeof INSTALL_BACKOFF;
}

/**
 * The supervisor's gate. Resolves once `bun install` has succeeded, and not
 * before: nothing boots over dependencies that disagree with `bun.lock`.
 *
 * There is no old server to fall back to — the restart already stopped it —
 * and the checkout on disk is the new code, so booting would be the
 * missing-import crash this exists to prevent.
 *
 * It WAITS rather than exiting. Under launchd (`KeepAlive: SuccessfulExit =
 * false`, `ThrottleInterval` 10s) an exit is a relaunch ten seconds later, so a
 * failure that never clears — a lockfile that disagrees with its manifests, a
 * registry that is down — would re-run the install ~360 times an hour, each
 * one registry traffic and another log line. Waiting in-process keeps launchd
 * satisfied and the retries on the backoff.
 *
 * The failure is also written to the data dir, keyed on `lockFingerprint`, so
 * a relaunch from any cause — `kickstart -k`, a crash — does not buy a fresh
 * attempt against the same inputs. A changed lockfile or manifest does: that
 * is the fix arriving, and waiting out a backoff for it would just be downtime.
 * The same check runs every `pollMs` while waiting, so a `git pull` that fixes
 * the lock is picked up without a restart.
 */
export async function installBeforeBoot(deps: InstallGateDeps): Promise<void> {
  const backoff = deps.backoff ?? INSTALL_BACKOFF;
  let last = deps.ledger.load();
  let justFailed = false;
  for (;;) {
    const fingerprint = deps.fingerprint();
    const sameInputs = last !== null && last.fingerprint === fingerprint;
    if (last && sameInputs) {
      const due = last.lastAttemptAt + installRetryDelayMs(last.failures, backoff);
      if (deps.now() < due) {
        if (!justFailed) {
          deps.log(
            `[supervisor] not re-running bun install yet: it failed ${last.failures} time(s) ` +
              `against this exact bun.lock, last at ${iso(last.lastAttemptAt)} (bun said: ` +
              `${oneLine(last.detail)}). Next attempt ${iso(due)}, sooner if bun.lock or a ` +
              `package.json changes; delete ${deps.ledgerPath} to retry now.`,
          );
        }
        await waitUntil(due, fingerprint, deps, backoff.pollMs);
        justFailed = false;
        continue;
      }
    }

    const result = deps.install();
    if (result.ok) {
      if (last) deps.ledger.save(null);
      return;
    }
    const failures = last && sameInputs ? last.failures + 1 : 1;
    last = { fingerprint, failures, lastAttemptAt: deps.now(), detail: result.detail ?? '' };
    deps.ledger.save(last);
    justFailed = true;
    deps.log(
      '[supervisor] bun install --frozen-lockfile FAILED — refusing to boot the server over ' +
        `dependencies that do not match bun.lock (failure ${failures} against this lock). ` +
        'Nothing will serve until an install succeeds. Next attempt ' +
        `${iso(last.lastAttemptAt + installRetryDelayMs(failures, backoff))}, sooner if ` +
        `bun.lock or a package.json changes. bun said: ${oneLine(result.detail ?? 'no detail')}`,
    );
  }
}

/** Sleep until `due`, returning early when the install's inputs change. */
async function waitUntil(
  due: number,
  fingerprint: string,
  deps: InstallGateDeps,
  pollMs: number,
): Promise<void> {
  while (deps.now() < due) {
    await deps.sleep(Math.min(pollMs, due - deps.now()));
    if (deps.fingerprint() !== fingerprint) return;
  }
}

/** One line: the caller stamps it with a time, and bun's multi-line reason
 *  would otherwise leave its continuation lines undated in the err log. */
function oneLine(text: string): string {
  return (text || 'no detail').split(/\s*\n\s*/).join(' | ');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The gate as `scripts/serve.ts --no-watch` runs it, against real bun. */
export function supervisorInstallGate(
  repoRoot: string,
  dataDir: string,
  log: (line: string) => void,
): InstallGateDeps {
  const ledgerPath = installLedgerPath(dataDir);
  return {
    install: spawnBunInstall(repoRoot),
    fingerprint: () => lockFingerprint(repoRoot),
    ledger: fileInstallLedger(ledgerPath),
    ledgerPath,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  };
}
