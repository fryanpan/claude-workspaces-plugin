#!/usr/bin/env bun
/**
 * The server suite's per-file times, and the table `--shard` balances on.
 *
 *   bun run scripts/server-durations.ts <run-id> [<run-id> ...]
 *
 * WHY. `bun run test:server --shard i/2` used to take every other file of a
 * hashed list. Equal counts, unequal work: replaying twelve green runs'
 * per-file times (17-18 Nov) through that split put 436s of test time in one
 * shard and 365s in the other. A shard's wall clock is close to its test time
 * over five (wall = 0.2 x test-seconds across 20 shard logs, intercept near
 * zero), so the heavy half finished about 14s after the light one, and the
 * server job was the last job of the run in 21 of 50 green runs.
 *
 * WHERE THE TIMES COME FROM. Every `server (N)` job's log, read with `gh`
 * (read only). bun prints a `##[group]<file>:` header per file and a
 * `(pass) name [Xms]` line per case; a fast case prints no time and counts as
 * zero. A file's weight is the sum of its cases. Hooks and module load are
 * not in it, which is why every file also pays `PER_FILE_SECONDS`.
 *
 * A committed table, for the reason `scripts/vitest-shard.ts` gives: both
 * runners must compute the SAME split, or a file runs twice or not at all.
 * A stale table can unbalance the shards; it cannot drop a file, because
 * `balancedShard` places every file in exactly one shard whatever it weighs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { median, mergeRuns } from './vitest-durations.ts';
import { balancedShard } from './vitest-shard.ts';

export const SERVER_DURATIONS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  'server-durations.json',
);

/** What a file costs beyond its cases' own times: a fork's import and its hooks. */
export const PER_FILE_SECONDS = 0.2;

export interface ServerDurations {
  /** Seconds for a file the table has no row for. */
  unmeasured: number;
  /** Repo-relative path → seconds of case time on CI. */
  seconds: Record<string, number>;
}

const ANSI = new RegExp(`(?:${String.fromCharCode(27)}|\\^\\[)\\[[0-9;]*m`, 'g');
const HEADER = /^##\[group\](packages\/server\/test\/\S+\.test\.tsx?):$/;
const CASE = /^\((?:pass|fail)\) .*?(?:\[([\d.]+)(ms|s)\])?\s*$/;

/** Repo-relative path → seconds, from one `server (N)` job's log text. */
export function parseServerDurations(log: string): Record<string, number> {
  const ms: Record<string, number> = {};
  let file: string | null = null;
  for (const raw of log.split('\n')) {
    // `gh run view --log` prefixes `<job>\t<step>\t<timestamp> `.
    const line = raw.replace(ANSI, '').replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '');
    const header = HEADER.exec(line);
    if (header) {
      file = header[1] ?? null;
      if (file) ms[file] ??= 0;
      continue;
    }
    // A chunk's footer ends the file it was reading.
    if (line.startsWith('Ran ')) file = null;
    const c = file ? CASE.exec(line) : null;
    if (!c || !file) continue;
    const [, value, unit] = c;
    if (value !== undefined) ms[file] = (ms[file] ?? 0) + Number(value) * (unit === 's' ? 1000 : 1);
  }
  const out: Record<string, number> = {};
  for (const [file, total] of Object.entries(ms)) out[file] = Math.round(total / 100) / 10;
  return out;
}

const NO_TABLE: ServerDurations = { unmeasured: 0, seconds: {} };

/** The committed table, or an empty one (every file then weighs the same). */
export function loadServerDurations(path = SERVER_DURATIONS_FILE): ServerDurations {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServerDurations>;
    if (typeof raw.unmeasured !== 'number' || !raw.seconds) {
      throw new Error('missing `unmeasured` or `seconds`');
    }
    return { unmeasured: raw.unmeasured, seconds: raw.seconds };
  } catch (err) {
    console.warn(
      `test-server: no usable duration table at ${path} (${String(err)}); shards will be uneven.`,
    );
    return NO_TABLE;
  }
}

/**
 * Shard `index` of `count` (1-based), balanced on measured time, in the order
 * the files came in. Keeping the caller's order keeps the chunks a shard runs
 * in the same hashed company `interleave` gave them.
 */
export function serverShard(
  files: readonly string[],
  index: number,
  count: number,
  durations: ServerDurations,
): string[] {
  const weight = (f: string) => (durations.seconds[f] ?? durations.unmeasured) + PER_FILE_SECONDS;
  const mine = new Set(balancedShard(files, (f) => f, weight, index, count));
  return files.filter((f) => mine.has(f));
}

export function buildServerTable(seconds: Record<string, number>): ServerDurations {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(seconds).sort()) sorted[key] = seconds[key] ?? 0;
  return { unmeasured: median(Object.values(seconds)), seconds: sorted };
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function readRun(run: string): Record<string, number> {
  const jobs = JSON.parse(
    gh(['api', `repos/{owner}/{repo}/actions/runs/${run}/jobs?per_page=100`, '--jq', '.jobs']),
  ) as { id: number; name: string; conclusion: string | null }[];
  const server = jobs.filter((j) => j.name.startsWith('server'));
  const bad = server.filter((j) => j.conclusion !== 'success');
  if (server.length === 0 || bad.length > 0) {
    console.error(
      `run ${run}: ${server.length} server job(s), ${bad.length} not successful — refusing to write a table from it.`,
    );
    process.exit(1);
  }
  const seconds: Record<string, number> = {};
  for (const job of server) {
    Object.assign(
      seconds,
      parseServerDurations(gh(['run', 'view', '--job', String(job.id), '--log'])),
    );
  }
  return seconds;
}

function main(): void {
  const runs = process.argv.slice(2);
  if (runs.length === 0 || runs.some((run) => !/^\d+$/.test(run))) {
    console.error('usage: bun run scripts/server-durations.ts <run-id> [<run-id> ...]');
    process.exit(2);
  }
  const table = buildServerTable(mergeRuns(runs.map(readRun)));
  writeFileSync(
    SERVER_DURATIONS_FILE,
    `${JSON.stringify({ source: { runs: runs.map(Number) }, ...table }, null, 2)}\n`,
  );
  console.log(
    `wrote ${Object.keys(table.seconds).length} file(s) from ${runs.length} run(s); unmeasured ${table.unmeasured}s.`,
  );
}

if (import.meta.main) main();
