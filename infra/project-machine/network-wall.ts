#!/usr/bin/env bun
/**
 * Shows two Fly private networks unable to reach each other.
 *
 *   bun run machine:network-wall --dry-run     print every fly command, make nothing
 *   bun run machine:network-wall [--region sjc]
 *
 * Makes three throwaway apps (`network-wall-plan.ts`), one smallest machine
 * each, probes across the two networks in both directions by name
 * (`<app>.internal`) and by 6PN address, and probes within one network as
 * the control. Every app it made is destroyed at the end, also when a step
 * fails. Prints a table and exits 1 unless every control connected, every
 * wall probe was refused, and nothing was left behind.
 *
 * `fly` runs with the org token the way `machine:deploy` runs it
 * (`mac-ops.ts`): FLY_API_TOKEN when set, else the Keychain's
 * `fly-org-token`, in the child's environment only. A dry run reads neither
 * the token nor the org.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RunResult, fly, keeperStage, keychainRead } from './mac-ops.ts';
import {
  PROBES,
  type Row,
  type Verdict,
  WALL_APPS,
  WALL_PY,
  type WallApp,
  type WallKey,
  appOf,
  flyArgs,
  judgeRow,
  readOutcome,
  table,
  verdict,
} from './network-wall-plan.ts';

export type FlyRunner = (args: string[]) => RunResult;

export interface WallOptions {
  run: FlyRunner;
  org: string;
  region: string;
  /** The probe file's local path, which `fly machine run` uploads. */
  probeFile: string;
  /** Tries per control: a fresh machine's name takes a moment to resolve. */
  controlTries?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface WallResult {
  rows: Row[];
  verdict: Verdict;
  /** The run stopped here, before every probe ran. */
  error?: string;
}

interface Placed {
  machine: string;
  sixpn: string;
}

function ok(run: FlyRunner, args: string[]): string {
  const r = run(args);
  if (r.status !== 0) {
    throw new Error(
      `fly ${args.slice(0, 3).join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return r.stdout;
}

const nameOf = (x: { Name?: string; name?: string }) => x.Name ?? x.name ?? '';

function placed(run: FlyRunner, a: WallApp): Placed {
  const list = JSON.parse(ok(run, flyArgs.listMachines(a)) || '[]') as Array<{
    id?: string;
    private_ip?: string;
  }>;
  const m = list.find((x) => x.id && x.private_ip);
  if (!m?.id || !m.private_ip) throw new Error(`${a.app} has no machine with a 6PN address`);
  return { machine: m.id, sixpn: m.private_ip };
}

/** Whether the app exists; unknown counts as yes, so a leftover is never missed. */
function stillThere(run: FlyRunner, a: WallApp): boolean {
  try {
    const r = run(flyArgs.listApps());
    if (r.status !== 0) return true;
    return (JSON.parse(r.stdout || '[]') as Array<{ Name?: string; name?: string }>).some(
      (x) => nameOf(x) === a.app,
    );
  } catch {
    return true;
  }
}

export async function runNetworkWall(opts: WallOptions): Promise<WallResult> {
  const log = opts.log ?? console.log;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const tries = opts.controlTries ?? 10;
  const created: WallApp[] = [];
  const rows: Row[] = [];
  const leftOver: string[] = [];
  let error: string | undefined;
  try {
    const existing = new Set(
      (JSON.parse(ok(opts.run, flyArgs.listApps()) || '[]') as Array<{ Name?: string }>).map(
        nameOf,
      ),
    );
    const there = WALL_APPS.filter((a) => existing.has(a.app)).map((a) => a.app);
    if (there.length > 0) {
      // Left by an earlier run. Not destroyed here: this run did not make them.
      throw new Error(
        `already exist: ${there.join(', ')}. Destroy them first: ${there.map((a) => `fly apps destroy ${a} --yes`).join('; ')}`,
      );
    }
    for (const a of WALL_APPS) {
      // Counted before the call: a create that fails can still leave the app.
      created.push(a);
      ok(opts.run, flyArgs.createApp(a, opts.org));
      ok(opts.run, flyArgs.runMachine(a, opts.region, opts.probeFile));
    }
    const at = new Map<WallKey, Placed>(WALL_APPS.map((a) => [a.key, placed(opts.run, a)]));
    for (const p of PROBES) {
      const from = at.get(p.from);
      const to = at.get(p.to);
      if (!from || !to) throw new Error(`no machine for ${p.from} or ${p.to}`);
      const host = p.via === '6PN' ? to.sixpn : `${appOf(p.to).app}.internal`;
      const attempts = p.kind === 'control' ? tries : 1;
      let row = judgeRow(p, 'not-run');
      for (let i = 0; i < attempts; i++) {
        const r = opts.run(flyArgs.probe(appOf(p.from), from.machine, host));
        row = judgeRow(p, readOutcome(r.status, r.stdout));
        if (row.ok || row.outcome === 'not-run' || i === attempts - 1) break;
        await sleep(3000);
      }
      rows.push(row);
      if (p.kind === 'control' && !row.ok && row.outcome !== 'not-run') break;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    // Every app this run made, newest first, each tried even if one fails.
    for (const a of [...created].reverse()) {
      let destroyed = false;
      try {
        destroyed = opts.run(flyArgs.destroyApp(a)).status === 0;
      } catch {
        // Counted below as left over.
      }
      if (destroyed) log(`[network-wall] destroyed ${a.app}`);
      else if (stillThere(opts.run, a)) leftOver.push(a.app);
    }
  }
  const v = verdict(rows, PROBES.length, leftOver);
  if (error) v.reasons.unshift(`stopped: ${error}`);
  return {
    rows,
    verdict: { ok: v.reasons.length === 0, reasons: v.reasons },
    ...(error ? { error } : {}),
  };
}

/** Prints each command and answers as a fresh account would; makes nothing. */
export function dryRunner(log: (line: string) => void = console.log): FlyRunner {
  return (args) => {
    log(`fly ${args.join(' ')}`);
    const app = args[args.indexOf('--app') + 1] ?? 'app';
    if (args[0] === 'apps' && args[1] === 'list') return { status: 0, stdout: '[]', stderr: '' };
    if (args[0] === 'machine' && args[1] === 'list')
      return {
        status: 0,
        stdout: JSON.stringify([{ id: `<${app}-machine>`, private_ip: `<${app}-6pn>` }]),
        stderr: '',
      };
    if (args[0] === 'machine' && args[1] === 'exec')
      return { status: 0, stdout: 'result=dry-run', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const region = arg(args, 'region') ?? 'sjc';
  if (!/^[a-z]{3}$/.test(region)) throw new Error(`--region is a Fly region code, not ${region}`);
  const stage = dryRun ? null : keeperStage('cw-network-wall-');
  try {
    let probeFile = '<probe-file>';
    if (stage) {
      probeFile = join(stage.dir, 'wall.py');
      writeFileSync(probeFile, WALL_PY);
      stage.share(probeFile);
    }
    const result = await runNetworkWall({
      run: dryRun ? dryRunner() : (a) => fly(a),
      org: dryRun ? '<org>' : keychainRead('fly-org-slug').trim(),
      region,
      probeFile,
      ...(dryRun ? { controlTries: 1, log: () => {} } : {}),
    });
    console.log(table(result.rows));
    if (dryRun) {
      console.log('[network-wall] DRY RUN: nothing was made, no probe ran');
      return;
    }
    for (const r of result.verdict.reasons) console.log(`[network-wall] ${r}`);
    console.log(`[network-wall] ${result.verdict.ok ? 'PASS' : 'FAIL'}`);
    if (!result.verdict.ok) process.exitCode = 1;
  } finally {
    stage?.done();
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`[network-wall] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
