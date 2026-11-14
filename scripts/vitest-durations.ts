#!/usr/bin/env bun
/**
 * Rewrite `scripts/vitest-durations.json` from one CI run's client shards.
 *
 *   bun run scripts/vitest-durations.ts <run-id>
 *
 * Reads every `client (N)` job's log with `gh` (read only), takes the
 * per-file time vitest prints for each file, and writes the table
 * `scripts/vitest-shard.ts` balances shards with. Refuses a run whose client
 * jobs did not all succeed: a failed or cancelled shard's files would be
 * missing or short, and the next split would be balanced on the wrong numbers.
 *
 * When to run it: when the client shards' durations in a CI run have drifted
 * apart again. A stale table never drops a test; it only makes the split
 * uneven.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callsBrowserGate } from './vitest-sequencer.ts';
import { DURATIONS_FILE, type Durations } from './vitest-shard.ts';

/**
 * vitest's per-file summary line, after the log's timestamp:
 * `✓  dom  packages/widget/test/x.test.ts (14 tests) 99270ms`. A file whose
 * every case skipped prints no time, and counts as zero.
 */
const FILE_LINE = /^\s*[✓↓×❯]\s+(\S+)\s+(\S+\.test\.tsx?)\s+\(([^)]*)\)(?:\s+([\d.]+)(ms|s))?\s*$/;

/**
 * The colour codes vitest writes even into a CI log. `gh run view --log`
 * prints each ESC as the two characters `^[` when its output is not a
 * terminal, so both spellings are stripped.
 */
const ANSI = new RegExp(`(?:${String.fromCharCode(27)}|\\^\\[)\\[[0-9;]*m`, 'g');

/** `<project>:<path>` → seconds, from one job's log text. */
export function parseDurations(log: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of log.split('\n')) {
    // `gh run view --log` prefixes `<job>\t<step>\t<timestamp> `.
    const line = raw.replace(ANSI, '').replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '');
    const m = FILE_LINE.exec(line);
    if (!m) continue;
    const [, project, path, , value, unit] = m;
    const seconds = value === undefined ? 0 : unit === 'ms' ? Number(value) / 1000 : Number(value);
    out[`${project}:${path}`] = Math.round(seconds * 10) / 10;
  }
  return out;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** The table, with the default for an unmeasured file taken from the measured ones of its kind. */
export function buildTable(
  seconds: Record<string, number>,
  isBrowser: (key: string) => boolean,
): Durations {
  const browser: number[] = [];
  const other: number[] = [];
  for (const [key, s] of Object.entries(seconds)) (isBrowser(key) ? browser : other).push(s);
  const sortedSeconds: Record<string, number> = {};
  for (const key of Object.keys(seconds).sort()) sortedSeconds[key] = seconds[key] ?? 0;
  return {
    unmeasured: { browser: median(browser), other: median(other) },
    seconds: sortedSeconds,
  };
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function main(): void {
  const run = process.argv[2];
  if (!run || !/^\d+$/.test(run)) {
    console.error('usage: bun run scripts/vitest-durations.ts <run-id>');
    process.exit(2);
  }
  const jobs = JSON.parse(
    gh(['api', `repos/{owner}/{repo}/actions/runs/${run}/jobs?per_page=100`, '--jq', '.jobs']),
  ) as { id: number; name: string; conclusion: string | null }[];
  const client = jobs.filter((j) => j.name.startsWith('client'));
  const bad = client.filter((j) => j.conclusion !== 'success');
  if (client.length === 0 || bad.length > 0) {
    console.error(
      `run ${run}: ${client.length} client job(s), ${bad.length} not successful — refusing to write a table from it.`,
    );
    process.exit(1);
  }
  const seconds: Record<string, number> = {};
  for (const job of client)
    Object.assign(seconds, parseDurations(gh(['run', 'view', '--job', String(job.id), '--log'])));
  const root = join(import.meta.dirname, '..');
  const table = buildTable(seconds, (key) =>
    callsBrowserGate(join(root, key.slice(key.indexOf(':') + 1))),
  );
  writeFileSync(
    DURATIONS_FILE,
    `${JSON.stringify({ source: { run: Number(run) }, ...table }, null, 2)}\n`,
  );
  console.log(
    `wrote ${Object.keys(table.seconds).length} file(s) from ${client.length} client job(s) of run ${run}; ` +
      `unmeasured browser ${table.unmeasured.browser}s, other ${table.unmeasured.other}s.`,
  );
}

if (import.meta.main) main();
