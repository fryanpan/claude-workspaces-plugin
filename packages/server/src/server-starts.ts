/**
 * Every server start, and what caused it — so a restart nobody asked for is
 * found the morning after rather than never.
 *
 * The daily health check is told to treat a process start that no deploy
 * explains as a crash. Until this file existed it could not: `ps` names only
 * the CURRENT process's start, launchd counts runs it cannot attribute, and
 * the deploy log held one record. So the check read as clean whatever had
 * happened overnight.
 *
 * Each boot writes its own record in two steps, because the two facts are
 * known at different moments:
 *
 *   recordServerStart   — at process start: when, which pid, when the host
 *                         booted, and the watchdog restart that explains it
 *                         (read from `supervisor-restarts.json` NOW, because
 *                         that ledger keeps only the last hour)
 *   markServerServing   — once the port is bound and documents hydrated:
 *                         when, and the pending deploy this boot confirmed
 *
 * A start with no second step never served — a crash before the port. The
 * cause is decided by the record alone (`classifyStart`), and
 * `summarizeStarts` turns a window of them into "N starts, M explained by
 * deploys, K unexplained". `scripts/server-starts.ts` prints that.
 *
 * Bounded like the deploy log: 30 days measured from the newest entry, then a
 * 500-entry ceiling for a crash loop nobody is watching.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join } from 'node:path';
import type { DeployResult } from './deploy-log.ts';
import { fileRestartLedger, restartLedgerPath } from './supervisor-health.ts';

export const SERVER_STARTS_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const SERVER_STARTS_MAX_ENTRIES = 500;

export interface ServerStart {
  /** When the process started (its time origin, not when this was written). */
  startedAt: number;
  pid: number;
  /** When the machine booted. */
  hostBootAt?: number;
  /** The first start since the host booted — the reboot's, not a crash. */
  firstSinceHostBoot?: true;
  /** The supervisor watchdog's restart that preceded this start, if any. */
  watchdogRestartAt?: number;
  /** When the server was serving. Absent: it never got there. */
  servingAt?: number;
  /** The `ranAt` of the pending deploy this boot confirmed — the join key
   *  into `deploy-log.json`. */
  deployRanAt?: number;
}

export type StartCause = 'deploy' | 'watchdog' | 'host-reboot' | 'unexplained';

export function serverStartsPath(dataDir: string): string {
  return join(dataDir, 'server-starts.json');
}

function isStart(v: unknown): v is ServerStart {
  const s = v as ServerStart | null;
  return typeof s?.startedAt === 'number' && typeof s.pid === 'number';
}

/** Oldest first. A missing or unreadable file reads as no records. */
export function readServerStarts(file: string): ServerStart[] {
  try {
    if (!existsSync(file)) return [];
    const entries = (JSON.parse(readFileSync(file, 'utf8')) as { entries?: unknown })?.entries;
    return Array.isArray(entries) ? entries.filter(isStart) : [];
  } catch {
    return [];
  }
}

export function pruneServerStarts(entries: ServerStart[]): ServerStart[] {
  const newest = entries.at(-1);
  if (!newest) return [];
  const floor = newest.startedAt - SERVER_STARTS_MAX_AGE_MS;
  return entries.filter((e) => e.startedAt >= floor).slice(-SERVER_STARTS_MAX_ENTRIES);
}

function writeServerStarts(file: string, entries: ServerStart[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp~`;
    writeFileSync(tmp, `${JSON.stringify({ entries: pruneServerStarts(entries) }, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    // Losing the record must never stop the server booting.
    console.error('[starts] could not record this server start:', err);
  }
}

/** With no earlier start on record, a start this soon after the host booted
 *  is taken as the reboot's. Only the very first record ever relies on it. */
export const HOST_BOOT_FALLBACK_WINDOW_MS = 15 * 60_000;

/**
 * Append this start, with the causes only the moment of starting can see.
 *
 * The watchdog restart that explains it is the latest ledger entry after the
 * previous start and no later than this one: the watchdog stamps the ledger,
 * exits, and launchd starts the supervisor that starts us. An entry from
 * before the previous start explained THAT one.
 *
 * A host boot explains only the FIRST start after it. The service starts at
 * login, which can be long after the kernel booted, so the test is "the
 * previous start was before the boot", not a window — and it is decided here,
 * against the previous record, so pruning can never make an old start look
 * like the first.
 */
export function recordServerStart(
  file: string,
  start: Pick<ServerStart, 'startedAt' | 'pid' | 'hostBootAt'>,
  watchdogRestarts: readonly number[],
): ServerStart {
  const entries = readServerStarts(file);
  const previous = entries.at(-1);
  const after = previous?.startedAt ?? Number.NEGATIVE_INFINITY;
  const restart = watchdogRestarts
    .filter((t) => t > after && t <= start.startedAt)
    .reduce<number | undefined>((a, t) => (a === undefined || t > a ? t : a), undefined);
  const boot = start.hostBootAt;
  const firstSinceBoot =
    boot !== undefined &&
    start.startedAt >= boot &&
    (previous ? previous.startedAt < boot : start.startedAt - boot <= HOST_BOOT_FALLBACK_WINDOW_MS);
  const record: ServerStart = {
    ...start,
    ...(firstSinceBoot ? { firstSinceHostBoot: true as const } : {}),
    ...(restart !== undefined ? { watchdogRestartAt: restart } : {}),
  };
  writeServerStarts(file, [...entries, record]);
  return record;
}

/** The second step: this boot is serving, and maybe confirmed a deploy. */
export function markServerServing(
  file: string,
  start: Pick<ServerStart, 'startedAt' | 'pid'>,
  facts: { servingAt: number; deployRanAt?: number },
): void {
  const entries = readServerStarts(file);
  const mine = entries.filter((e) => e.startedAt === start.startedAt && e.pid === start.pid).at(-1);
  if (!mine) return;
  writeServerStarts(
    file,
    entries.map((e) => (e === mine ? { ...e, ...facts } : e)),
  );
}

/** This process's start, recorded with the facts only it can gather. */
export function recordThisServerStart(dataDir: string): ServerStart {
  const now = Date.now();
  return recordServerStart(
    serverStartsPath(dataDir),
    {
      startedAt: Math.round(performance.timeOrigin),
      pid: process.pid,
      hostBootAt: Math.round(now - uptime() * 1000),
    },
    fileRestartLedger(restartLedgerPath(dataDir)).load(),
  );
}

/** Why this server started. A confirmed deploy wins — it is the most
 *  specific claim, and the one the uptime report labels an outage with. */
export function classifyStart(start: ServerStart): StartCause {
  if (start.deployRanAt !== undefined) return 'deploy';
  if (start.watchdogRestartAt !== undefined) return 'watchdog';
  if (start.firstSinceHostBoot) return 'host-reboot';
  return 'unexplained';
}

export interface StartRow extends ServerStart {
  cause: StartCause;
}

export interface StartsSummary {
  since: number;
  until: number;
  /** The oldest start on record, or null when nothing was ever recorded —
   *  which is not the same as zero starts. */
  recordedFrom: number | null;
  starts: StartRow[];
  counts: Record<StartCause, number> & { total: number };
  /** Deploys in the window that asked for a restart, by verdict. */
  deploys: { restarts: number; healthy: number; failed: number; pending: number };
}

export function summarizeStarts(opts: {
  starts: ServerStart[];
  deploys: DeployResult[];
  since: number;
  until: number;
}): StartsSummary {
  const { starts, since, until } = opts;
  const rows: StartRow[] = starts
    .filter((s) => s.startedAt >= since && s.startedAt <= until)
    .map((s) => ({ ...s, cause: classifyStart(s) }));
  const counts = { total: rows.length, deploy: 0, watchdog: 0, 'host-reboot': 0, unexplained: 0 };
  for (const r of rows) counts[r.cause]++;

  const deploys = { restarts: 0, healthy: 0, failed: 0, pending: 0 };
  for (const d of opts.deploys) {
    if (!d.restartRequested || d.ranAt < since || d.ranAt > until) continue;
    deploys.restarts++;
    const v = d.verification;
    // A pending past its deadline is a failure nobody survived to write —
    // the same reading `Deployer.last` gives it.
    if (v?.state === 'healthy') deploys.healthy++;
    else if (v?.state === 'pending' && until < v.deadlineAt) deploys.pending++;
    else deploys.failed++;
  }
  return {
    since,
    until,
    recordedFrom: starts[0]?.startedAt ?? null,
    starts: rows,
    counts,
    deploys,
  };
}

const iso = (t: number) => new Date(t).toISOString();

/** The report the health check reads, as plain lines. */
export function formatStartsReport(s: StartsSummary, file: string): string {
  if (s.recordedFrom === null) {
    return (
      `no server start has ever been recorded at ${file} — this is not a zero. ` +
      'Either the data dir is wrong, or the server predates start recording.'
    );
  }
  const c = s.counts;
  const d = s.deploys;
  const lines = [
    `server starts since ${iso(s.since)}: ${c.total} — ${c.deploy} explained by deploys, ` +
      `${c.watchdog} by the watchdog, ${c['host-reboot']} by a host reboot, ${c.unexplained} unexplained`,
    `deploys that restarted the server: ${d.restarts} — ${d.healthy} healthy, ` +
      `${d.failed} boot-failed, ${d.pending} pending`,
  ];
  if (s.recordedFrom > s.since) {
    lines.push(`start records begin at ${iso(s.recordedFrom)}; earlier starts are not counted`);
  }
  const unexplained = s.starts.filter((r) => r.cause === 'unexplained');
  if (unexplained.length) {
    lines.push('unexplained starts — root-cause each from the err log around its time:');
    for (const r of unexplained) {
      const served = r.servingAt !== undefined ? `served ${iso(r.servingAt)}` : 'never served';
      lines.push(`  ${iso(r.startedAt)}  pid ${r.pid}  ${served}`);
    }
  }
  return lines.join('\n');
}
