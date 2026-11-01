#!/usr/bin/env bun
/**
 * The project machines CI deploys after every Cloudflare apply on main
 * (`.github/workflows/cloudflare.yml`), read from the committed
 * `machines.json`:
 *
 *   { "machines": [ { "project": "<name>", "tunnel": "named",
 *                     "memory": 2048, "leadBoard": "<board id>" } ] }
 *
 * Only `project` is required; `tunnel` defaults to named. Nothing here is a
 * secret: the app is `cw-<project>` (`deploy-plan.ts`), and every credential
 * comes from the job's environment.
 *
 *   bun infra/project-machine/machines.ts deploy [--ref <commit>] [--dry-run]
 *
 * runs `machine:deploy` for each machine in order and stops at the first
 * failure. A machine the Mac never made is refused there, before any change.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECT_NAME } from './deploy-plan.ts';

const HERE = dirname(new URL(import.meta.url).pathname);
export const MACHINES_FILE = join(HERE, 'machines.json');

export interface Machine {
  project: string;
  tunnel: 'named' | 'quick';
  memory?: number;
  leadBoard?: string;
}

/** The list, checked. Throws naming the entry, so a bad commit fails before any deploy. */
export function parseMachines(raw: string): Machine[] {
  const list = (JSON.parse(raw) as { machines?: unknown }).machines;
  if (!Array.isArray(list)) throw new Error('machines.json has no "machines" list');
  const seen = new Set<string>();
  return list.map((m: Record<string, unknown>, i) => {
    const project = m?.project;
    if (typeof project !== 'string' || !PROJECT_NAME.test(project)) {
      throw new Error(`machines.json entry ${i} has no valid project`);
    }
    if (seen.has(project)) throw new Error(`machines.json lists ${project} twice`);
    seen.add(project);
    const tunnel = m.tunnel ?? 'named';
    if (tunnel !== 'named' && tunnel !== 'quick')
      throw new Error(`${project}: tunnel is named or quick`);
    if (m.memory !== undefined && !(Number.isInteger(m.memory) && (m.memory as number) > 0)) {
      throw new Error(`${project}: memory is a whole number of MB`);
    }
    if (m.leadBoard !== undefined && typeof m.leadBoard !== 'string') {
      throw new Error(`${project}: leadBoard is a board id`);
    }
    return {
      project,
      tunnel,
      ...(m.memory !== undefined ? { memory: m.memory as number } : {}),
      ...(m.leadBoard !== undefined ? { leadBoard: m.leadBoard as string } : {}),
    };
  });
}

/** The `machine:deploy` arguments for one machine. */
export function deployArgs(m: Machine, ref: string, dryRun: boolean): string[] {
  return [
    '--project',
    m.project,
    '--tunnel',
    m.tunnel,
    '--ref',
    ref,
    ...(m.memory !== undefined ? ['--memory', String(m.memory)] : []),
    ...(m.leadBoard !== undefined ? ['--lead-board', m.leadBoard] : []),
    ...(dryRun ? ['--dry-run'] : []),
  ];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] !== 'deploy') {
    console.error(
      'usage: bun infra/project-machine/machines.ts deploy [--ref <commit>] [--dry-run]',
    );
    process.exit(2);
  }
  const i = args.indexOf('--ref');
  const ref = i >= 0 ? (args[i + 1] ?? 'HEAD') : 'HEAD';
  const machines = parseMachines(readFileSync(MACHINES_FILE, 'utf8'));
  if (machines.length === 0) console.log('[machines] machines.json lists no project machine');
  for (const m of machines) {
    console.log(`[machines] ${m.project}`);
    const r = spawnSync(
      process.execPath,
      [join(HERE, 'deploy.ts'), ...deployArgs(m, ref, args.includes('--dry-run'))],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) {
      console.error(`[machines] ${m.project} failed; the machines after it were not deployed`);
      process.exit(1);
    }
  }
}
