#!/usr/bin/env bun
/**
 * The project machines, read from the committed `machines.json`. Machines
 * install signed releases themselves (`release-cli.ts`); `fly.yml` runs this
 * to update each one's image, one job per project, each in its own GitHub
 * Environment holding a token for that project's app alone (`ci-tokens.ts`).
 *
 *   { "machines": [ { "project": "<name>", "tunnel": "named",
 *                     "memory": 2048, "leadBoard": "<board id>",
 *                     "pushRepos": ["<owner>/<name>"] } ] }
 *
 * Only `project` is required; `tunnel` defaults to named. `pushRepos` are the
 * repos the project's server pushes to, one write deploy key each: they are
 * read from this file and nowhere else, so only a merged change decides which
 * repos get a key that writes.
 *
 * `seedBoard` names a board the project's server starts with, letting in
 * the collaborators the Keychain's `cw-test-collaborator-email` lists
 * (`settings.ts`, `packages/server/src/seed-board.ts`): the test servers'.
 *
 * `leadToken` pins the label of the listed Claude token the project's lead
 * signs in with (`token-list.ts`); a deploy takes a listed token only where
 * this file pins it, so which org uses which sign-in is written down and
 * merged (wall-off review H2). Several projects may pin one label: Bryan
 * chose shared tokens, and a lead moves orgs between them to spread usage
 * (2026-11-24). `remoteControl: true` allows the lead's Remote
 * Control, which the daily wall report otherwise fails. Nothing here is a
 * secret: the app is `cw-<project>` (`deploy-plan.ts`), and every credential
 * comes from the Keychain, or from the environment with CW_SECRETS_FROM_ENV=1.
 *
 *   bun infra/project-machine/machines.ts deploy [--project <name>] [--ref <commit>]
 *       [--dry-run] [--no-terraform-outputs] [-- <provisioning flags>]
 *   bun infra/project-machine/machines.ts matrix
 *
 * `deploy` runs `machine:deploy` for each machine in order (or the one
 * `--project` names) and stops at the first failure. A machine not yet made
 * is refused there, before any change, outside fly-provision.yml. After `--`,
 * fly-provision.yml passes `--refresh-push-keys` and `--refresh-tunnel-token`
 * through (`provisionFlags`); nothing else, and never a repo. `--no-terraform-outputs` is CI's:
 * its jobs hold no key to the state (`deploy.ts`). `matrix` prints
 * `matrix=<JSON list of projects>`, the line fly.yml appends to
 * `$GITHUB_OUTPUT`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRepoName } from '../../packages/server/src/git-push/policy.ts';
import { MAX_PUSH_REPOS } from '../../packages/server/src/provisioning/push-keys.ts';
import { PROJECT_NAME, SEED_BOARD_NAME } from './deploy-plan.ts';
import { TOKEN_LABEL } from './lead-usage.ts';

const HERE = dirname(new URL(import.meta.url).pathname);
export const MACHINES_FILE = join(HERE, 'machines.json');

export interface Machine {
  project: string;
  tunnel: 'named' | 'quick';
  memory?: number;
  leadBoard?: string;
  /** The repos the server pushes to, each with its own write deploy key. */
  pushRepos?: string[];
  /** The listed Claude token's label this project's lead signs in with. */
  leadToken?: string;
  /** The lead may run with Remote Control (`CW_LEAD_REMOTE_CONTROL`). */
  remoteControl?: boolean;
  /** The board the server starts with, its collaborators from the Keychain. */
  seedBoard?: string;
}

const flag = (project: string, m: Record<string, unknown>, name: string) => {
  const v = m[name];
  if (v !== undefined && typeof v !== 'boolean')
    throw new Error(`${project}: ${name} is true or false`);
  return v === undefined ? {} : { [name]: v };
};

function checkPushRepos(project: string, raw: unknown): string[] {
  const ok =
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.length <= MAX_PUSH_REPOS &&
    raw.every((r) => typeof r === 'string' && isRepoName(r)) &&
    new Set(raw).size === raw.length;
  if (!ok)
    throw new Error(
      `${project}: pushRepos is a list of 1-${MAX_PUSH_REPOS} distinct owner/name repos`,
    );
  return [...(raw as string[])];
}

/** The list, checked. Throws naming the entry, so a bad commit fails before any deploy. */
export function parseMachines(raw: string): Machine[] {
  const list = (JSON.parse(raw) as { machines?: unknown }).machines;
  if (!Array.isArray(list)) throw new Error('machines.json has no "machines" list');
  const seen = new Set<string>();
  return list.map((m: Record<string, unknown>, i): Machine => {
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
    if (
      m.leadToken !== undefined &&
      (typeof m.leadToken !== 'string' || !TOKEN_LABEL.test(m.leadToken))
    ) {
      throw new Error(`${project}: leadToken is a token list label`);
    }
    if (
      m.seedBoard !== undefined &&
      (typeof m.seedBoard !== 'string' || !SEED_BOARD_NAME.test(m.seedBoard))
    ) {
      throw new Error(`${project}: seedBoard is a board name of 1-120 printable characters`);
    }
    return {
      project,
      tunnel,
      ...(m.memory !== undefined ? { memory: m.memory as number } : {}),
      ...(m.leadBoard !== undefined ? { leadBoard: m.leadBoard as string } : {}),
      ...(m.pushRepos !== undefined ? { pushRepos: checkPushRepos(project, m.pushRepos) } : {}),
      ...(m.leadToken !== undefined ? { leadToken: m.leadToken as string } : {}),
      ...flag(project, m, 'remoteControl'),
      ...(m.seedBoard !== undefined ? { seedBoard: m.seedBoard as string } : {}),
    };
  });
}

/** The committed list. */
export const readMachines = (): Machine[] => parseMachines(readFileSync(MACHINES_FILE, 'utf8'));

/** The `machine:deploy` arguments for one machine. */
export function deployArgs(m: Machine, ref: string, dryRun: boolean, noOutputs = false): string[] {
  return [
    '--project',
    m.project,
    '--tunnel',
    m.tunnel,
    '--ref',
    ref,
    ...(m.memory !== undefined ? ['--memory', String(m.memory)] : []),
    ...(m.leadBoard !== undefined ? ['--lead-board', m.leadBoard] : []),
    ...(m.pushRepos ?? []).flatMap((r) => ['--push-repo', r]),
    ...(m.seedBoard !== undefined ? ['--seed-board', m.seedBoard] : []),
    ...(dryRun ? ['--dry-run'] : []),
    ...(noOutputs ? ['--no-terraform-outputs'] : []),
  ];
}

const PASSED = new Set(['--refresh-push-keys', '--refresh-tunnel-token']);

/** The flags after `--` that pass through to `machine:deploy`. Throws on any other. */
export function provisionFlags(args: readonly string[]): string[] {
  const at = args.indexOf('--');
  if (at < 0) return [];
  const rest = args.slice(at + 1);
  const out: string[] = [];
  for (const a of rest) {
    if (PASSED.has(a)) out.push(a);
    else throw new Error(`${a || 'an empty argument'} is not a provisioning flag`);
  }
  return out;
}

/** fly.yml's job matrix: every project, in the file's order. */
export const matrixLine = (machines: readonly Machine[]): string =>
  `matrix=${JSON.stringify(machines.map((m) => m.project))}`;

/** The machines one run deploys: all, or the one `--project` names. */
export function selected(machines: Machine[], project: string | undefined): Machine[] {
  if (project === undefined) return machines;
  const one = machines.filter((m) => m.project === project);
  if (one.length === 0) throw new Error(`machines.json lists no project ${project}`);
  return one;
}

if (import.meta.main) {
  const allArgs = process.argv.slice(2);
  const cut = allArgs.indexOf('--');
  const args = cut < 0 ? allArgs : allArgs.slice(0, cut);
  const extra = provisionFlags(allArgs);
  const usage =
    'usage: bun infra/project-machine/machines.ts deploy [--project <name>] [--ref <commit>] [--dry-run] [--no-terraform-outputs] [-- --refresh-push-keys --refresh-tunnel-token] | matrix';
  const all = parseMachines(readFileSync(MACHINES_FILE, 'utf8'));
  if (args[0] === 'matrix') {
    console.log(matrixLine(all));
    process.exit(0);
  }
  if (args[0] !== 'deploy') {
    console.error(usage);
    process.exit(2);
  }
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const ref = value('--ref') ?? 'HEAD';
  const machines = selected(all, value('--project'));
  if (machines.length === 0) console.log('[machines] machines.json lists no project machine');
  for (const m of machines) {
    console.log(`[machines] ${m.project}`);
    const r = spawnSync(
      process.execPath,
      [
        join(HERE, 'deploy.ts'),
        ...deployArgs(m, ref, args.includes('--dry-run'), args.includes('--no-terraform-outputs')),
        ...extra,
      ],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) {
      console.error(`[machines] ${m.project} failed; the machines after it were not deployed`);
      process.exit(1);
    }
  }
}
