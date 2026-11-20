#!/usr/bin/env bun
/**
 * The daily prod check's wall report: whether project servers refuse each
 * other's credentials, and how Cloudflare walls each project, as the
 * Terraform outputs say.
 *
 *   bun run machine:wall-report [--projects a,b] [--no-drift] [--dry-run]
 *
 * Cross-project refusals, in the terms of `cross-server-walls.test.ts`: on
 * each project machine `wall-probe.ts mint` signs one value of each expiring
 * type with that server's key, and every machine is asked for its verdict on
 * every batch. The issuer accepting its own batch is the control (a broken
 * probe fails it); every other server must refuse each value for its
 * signature, `bad_signature`, and for nothing else. The values are expired
 * before they are made, so nothing carried between machines is a credential
 * (`wall-probe.ts`).
 *
 * Cloudflare, per project, from `terraform output` (`infra/cloudflare/outputs.ts`),
 * which CI reads and seals to the Mac (`wall-read.ts`; the Mac holds no
 * Cloudflare credential and reads the newest read with `gh`): its own Access
 * application with an audience no other project shares, hosts no other
 * project's application lists, its tunnel `cw-<project>` with its own origin
 * and a public host its own application gates, and the router route for
 * that host.
 *
 * Drift (`wall-drift.ts`, read by `wall-drift-read.ts`): per machine, its Fly
 * network, public addresses and services, the server's admission settings
 * against the deploy's, trusted emails, the loopback uid policy,
 * `git-push.json`'s approval flags, the deploy key's read-only flag and the
 * tunnel's ingress; across the account, ONE_ADDRESS_ORIGIN, shared service
 * tokens, each project's live Access policies against `access.local.json`,
 * and a Cloudflare plan with no changes; in GitHub, no secret named
 * FLY_API_TOKEN anywhere and each `fly-<project>` environment admitting main
 * alone with a FLY_DEPLOY_TOKEN under 45 days old. `--no-drift` leaves it out.
 *
 * The projects are `--projects`, else every project the outputs give a
 * tunnel (a project machine). CI's read is prod's (`--tf-env prod`, the
 * default, is the only one). Each CI read gets a row of its own that fails
 * when it is over 36 hours old. Exits 1 unless every row passes. A dry run
 * prints what it would run and runs nothing.
 */
import type { TfOutputs } from '../cloudflare/outputs.ts';
import { onMachine } from './mac-ops.ts';
import { driftRows, realDriftIo } from './wall-drift-read.ts';
import { type Row as DriftRow, PROBE, appFor, lastJson } from './wall-drift.ts';
import type { Answer, Batch, WallType } from './wall-probe.ts';
import { WALL_TYPES } from './wall-probe.ts';
import { type Pulled, ciReadRow, pullWallRead, realWallReadPullIo } from './wall-read-pull.ts';
import type { FlyRead } from './wall-read.ts';

export { PROBE, appFor, lastJson };

/** Runs a command on a project's machine and returns its output. */
export type MachineExec = (app: string, command: string) => string;

export interface CrossRow {
  type: WallType;
  issuer: string;
  presentedTo: string;
  expect: 'accepted' | 'bad_signature';
  answer: Answer;
  ok: boolean;
}

export interface CfRow {
  project: string;
  check: string;
  answer: string;
  ok: boolean;
}

/** Every server's verdict on every server's batch, one row per type. */
export function crossRows(projects: readonly string[], exec: MachineExec): CrossRow[] {
  const batches = new Map<string, Batch | null>();
  for (const p of projects) {
    try {
      batches.set(p, lastJson<Batch>(exec(appFor(p), `${PROBE} mint`)));
    } catch {
      batches.set(p, null);
    }
  }
  const rows: CrossRow[] = [];
  for (const issuer of projects) {
    const batch = batches.get(issuer) ?? null;
    const arg = batch ? Buffer.from(JSON.stringify(batch)).toString('base64') : '';
    for (const to of projects) {
      const expect = issuer === to ? 'accepted' : 'bad_signature';
      let answers: Partial<Record<WallType, Answer>> = {};
      let failed = batch ? '' : 'mint-failed';
      if (batch) {
        try {
          answers = lastJson<Record<WallType, Answer>>(exec(appFor(to), `${PROBE} verify ${arg}`));
        } catch {
          failed = 'probe-error';
        }
      }
      for (const type of WALL_TYPES) {
        const answer = failed || answers[type] || 'no-answer';
        rows.push({ type, issuer, presentedTo: to, expect, answer, ok: answer === expect });
      }
    }
  }
  return rows;
}

/** How Cloudflare walls each project, from the Terraform outputs. */
export function cloudflareRows(outputs: TfOutputs, projects: readonly string[]): CfRow[] {
  const rows: CfRow[] = [];
  const add = (project: string, check: string, answer: string, ok: boolean) =>
    rows.push({ project, check, answer, ok });
  add(
    '(all)',
    'Access team domain',
    outputs.accessTeamDomain ?? 'none in the outputs',
    outputs.accessTeamDomain !== null,
  );
  const labels = [
    ...new Set([...projects, ...Object.keys(outputs.access), ...Object.keys(outputs.tunnels)]),
  ].sort();
  const routes = outputs.routerRoutes ?? {};
  for (const p of labels) {
    const access = outputs.access[p];
    const others = labels.filter((o) => o !== p);
    if (!access || access.hosts.length === 0) {
      add(p, 'Access application', 'none', false);
    } else {
      add(p, 'Access application', `gates ${access.hosts.join(', ')}`, true);
      const sameAud = others.filter((o) => outputs.access[o]?.aud === access.aud);
      add(
        p,
        'audience is its own',
        sameAud.length ? `shared with ${sameAud.join(', ')}` : 'no other project has it',
        sameAud.length === 0,
      );
      const shared = access.hosts.filter((h) =>
        others.some((o) => outputs.access[o]?.hosts.includes(h)),
      );
      add(
        p,
        'hosts are its own',
        shared.length ? `also under another project: ${shared.join(', ')}` : 'no host shared',
        shared.length === 0,
      );
    }
    const t = outputs.tunnels[p];
    if (!t) {
      // A project still on the Mac has no tunnel; one being checked must.
      if (projects.includes(p)) add(p, 'tunnel', 'none in the outputs', false);
    } else {
      const own = t.name === appFor(p) && t.origin.startsWith(`${p}-origin.`);
      add(p, 'tunnel', `${t.name} -> ${t.origin}`, own);
      const sharedOrigin = others.filter((o) => outputs.tunnels[o]?.origin === t.origin);
      if (sharedOrigin.length)
        add(p, 'tunnel origin is its own', `shared with ${sharedOrigin.join(', ')}`, false);
      const gated = access?.hosts.includes(t.public_host) ?? false;
      add(
        p,
        'tunnel host behind its own Access app',
        gated ? t.public_host : `${t.public_host} is not one of its hosts`,
        gated,
      );
    }
    const route = routes[p];
    if (route !== undefined) {
      const host = route.replace(/\/\*$/, '');
      const gated = access?.hosts.includes(host) ?? false;
      add(p, 'router route behind its own Access app', route, gated);
    }
  }
  return rows;
}

function renderTable(head: string[], body: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(head), ...body.map(line)].join('\n');
}

export interface Report {
  ok: boolean;
  text: string;
}

export function report(
  projects: readonly string[],
  cross: readonly CrossRow[],
  cf: readonly CfRow[],
  drift: readonly DriftRow[] = [],
): Report {
  const reasons: string[] = [];
  if (projects.length < 2)
    reasons.push(
      `${projects.length} project machine(s): a cross-project refusal needs two, so none was checked`,
    );
  const controlsFailed = cross.some((r) => r.expect === 'accepted' && !r.ok);
  if (controlsFailed)
    reasons.push('a server did not accept its own value, so its refusals prove nothing');
  const crossFails = cross.filter((r) => r.expect === 'bad_signature' && !r.ok).length;
  if (crossFails)
    reasons.push(`${crossFails} cross-project value(s) were not refused for the signature`);
  const cfFails = cf.filter((r) => !r.ok).length;
  if (cfFails) reasons.push(`${cfFails} Cloudflare check(s) failed`);
  const driftFails = drift.filter((r) => !r.ok).length;
  if (driftFails) reasons.push(`${driftFails} drift check(s) failed`);
  const ok = reasons.length === 0;
  const text = [
    "Cross-project refusals (each server must accept its own value, the control, and refuse every other server's for its signature)",
    renderTable(
      ['type', 'signed by', 'presented to', 'expected', 'answer', 'result'],
      cross.map((r) => [
        r.type,
        r.issuer,
        r.presentedTo,
        r.expect,
        r.answer,
        r.ok ? 'PASS' : 'FAIL',
      ]),
    ),
    '',
    "Cloudflare's config, from the Terraform outputs",
    renderTable(
      ['project', 'check', 'answer', 'result'],
      cf.map((r) => [r.project, r.check, r.answer, r.ok ? 'PASS' : 'FAIL']),
    ),
    '',
    ...(drift.length
      ? [
          'Drift: each machine, its Fly app and Cloudflare against the deploy and the config',
          renderTable(
            ['project', 'check', 'answer', 'result'],
            drift.map((r) => [r.project, r.check, r.answer, r.ok ? 'PASS' : 'FAIL']),
          ),
          '',
        ]
      : []),
    ...reasons.map((r) => `[wall-report] ${r}`),
    `[wall-report] ${ok ? 'PASS' : 'FAIL'}`,
  ].join('\n');
  return { ok, text };
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const PROJECT = /^[a-z0-9][a-z0-9-]{0,40}$/;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const tfEnv = arg(args, 'tf-env') ?? 'prod';
  const named = arg(args, 'projects')
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const p of named ?? [])
    if (!PROJECT.test(p)) throw new Error(`--projects: ${p} is not a project name`);
  if (tfEnv !== 'prod')
    throw new Error(
      `--tf-env ${tfEnv}: CI reads prod's Cloudflare state only (wall-read.yml); there is no ${tfEnv} read to report on`,
    );
  if (dryRun) {
    const projects = named ?? ['<each project with a tunnel>'];
    console.log(
      `gh run download <newest wall-read.yml run on main> --name wall-read-cloudflare  (sealed to this Mac: prod's Terraform outputs, each tunnel's configuration, the live Access applications and service token names, a plan in CI mode)`,
    );
    console.log(
      'gh run download <newest wall-read.yml run on main> --name wall-read-fly  (sealed to this Mac: fly apps list)',
    );
    for (const p of projects)
      console.log(`fly ssh console --app ${appFor(p)} --command '${PROBE} mint'`);
    for (const p of projects)
      console.log(
        `fly ssh console --app ${appFor(p)} --command '${PROBE} verify <each project's batch>'`,
      );
    for (const p of projects) {
      console.log(`fly ips list --app ${appFor(p)} --json`);
      console.log(`fly machine list --app ${appFor(p)} --json`);
      console.log(`fly ssh console --app ${appFor(p)} --command '${PROBE} machine'`);
      console.log(`gh api repos/<each repo the lead of ${p} clones or may push>/keys`);
    }
    console.log(
      "gh api repos/<this repo>/environments, each one's secrets (names and times) and branch rules",
    );
    console.log('gh api repos/<this repo>/actions/secrets (names only)');
    console.log('[wall-report] DRY RUN: nothing was run');
    return;
  }
  // Cloudflare, and `fly apps list`, come from CI's sealed read: the Mac
  // holds neither a Cloudflare token nor the Fly org token (wall-read.ts).
  const pullIo = realWallReadPullIo();
  const cfRead = pullWallRead(pullIo, 'cloudflare');
  const outputs = cfRead.read.outputs;
  const projects = named ?? Object.keys(outputs.tunnels).sort();
  const cross = crossRows(projects, onMachine);
  const now = Date.now();
  let drift: DriftRow[] = [];
  if (!args.includes('--no-drift')) {
    let flyRead: Pulled<FlyRead> | Error;
    try {
      flyRead = pullWallRead(pullIo, 'fly');
    } catch (e) {
      flyRead = e instanceof Error ? e : new Error(String(e));
    }
    drift = [
      ciReadRow('fly', flyRead, now),
      ...(await driftRows(
        projects,
        outputs,
        realDriftIo(tfEnv, outputs, cfRead.read, flyRead instanceof Error ? null : flyRead.read),
      )),
    ];
  }
  const cf = [ciReadRow('cloudflare', cfRead, now), ...cloudflareRows(outputs, projects)];
  const r = report(projects, cross, cf, drift);
  console.log(r.text);
  if (!r.ok) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`[wall-report] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
