/**
 * Reads what the drift checks judge (`wall-drift.ts`), for `wall-report.ts`.
 * Every read is a read: `fly apps|ips|machine list`, `fly ssh console`
 * running `wall-probe.ts machine`, GitHub's deploy-key list, the tunnel's
 * configuration from Cloudflare's API, the deploy's settings
 * (`settings.ts`, Keychain and Terraform outputs), the router config, and a
 * Cloudflare plan that holds no lock and applies nothing.
 */
import { spawnSync } from 'node:child_process';
import { isRepoName } from '../../packages/server/src/git-push/policy.ts';
import type { TfOutputs } from '../cloudflare/outputs.ts';
import { realIo, runWrapper } from '../cloudflare/run.ts';
import { configReader } from '../cloudflare/run.ts';
import type { TfEnv } from '../cloudflare/terraform.ts';
import { CONFIG_PATHS, type StaticVars, staticVars } from '../cloudflare/vars.ts';
import { cloudflareClient, flyJson, keychainHas, keychainRead, onMachine } from './mac-ops.ts';
import type { MachineFacts } from './machine-facts.ts';
import { readSettings } from './settings.ts';
import {
  type FlyView,
  type Ingress,
  PROBE,
  type RepoKeys,
  type Row,
  appFor,
  deployKeyRepos,
  deployKeyRows,
  flyRows,
  gitPushRows,
  ingressRows,
  lastJson,
  oneAddressRows,
  planRows,
  serviceTokenRows,
  settingsRows,
  uidRows,
} from './wall-drift.ts';

export interface DriftIo {
  fly: <T>(args: string[]) => T;
  exec: (app: string, command: string) => string;
  repoKeys: (repo: string) => RepoKeys;
  ingress: (tunnel: TfOutputs['tunnels'][string]) => Promise<Ingress | null>;
  /** What `machine:deploy` would set on the project's server, by name. */
  expected: (project: string) => Map<string, string>;
  routerVars: () => StaticVars;
  plan: () => Promise<{ status: number; summary: string }>;
}

export async function driftRows(
  projects: readonly string[],
  outputs: TfOutputs,
  io: DriftIo,
): Promise<Row[]> {
  const rows: Row[] = [];
  const view: FlyView = { apps: io.fly(['apps', 'list']), ips: {}, machines: {} };
  for (const p of projects) {
    const app = appFor(p);
    try {
      view.ips[app] = io.fly(['ips', 'list', '--app', app]);
      view.machines[app] = io.fly(['machine', 'list', '--app', app]);
    } catch {
      // flyRows names an app it has no answer for.
    }
  }
  rows.push(...flyRows(projects, view));
  for (const p of projects) {
    let facts: MachineFacts;
    try {
      facts = lastJson<MachineFacts>(io.exec(appFor(p), `${PROBE} machine`));
    } catch {
      rows.push({ project: p, check: 'machine probe', answer: 'did not answer', ok: false });
      continue;
    }
    rows.push(...settingsRows(p, io.expected(p), facts));
    rows.push(...uidRows(p, facts));
    rows.push(...gitPushRows(p, facts));
    const keys: Record<string, RepoKeys> = {};
    if (facts.deployKey) for (const r of deployKeyRepos(facts)) keys[r] = io.repoKeys(r);
    rows.push(...deployKeyRows(p, facts, keys));
    const t = outputs.tunnels[p];
    rows.push(...ingressRows(p, t?.public_host, t ? await io.ingress(t) : null, facts));
  }
  try {
    const v = io.routerVars();
    rows.push(...oneAddressRows(v), ...serviceTokenRows(v.access_projects));
  } catch (e) {
    rows.push({
      project: '(all)',
      check: 'router and Access config',
      answer: `could not be read: ${e instanceof Error ? e.message : String(e)}`,
      ok: false,
    });
  }
  const plan = await io.plan();
  rows.push(...planRows(plan.status, plan.summary));
  return rows;
}

export function realDriftIo(tfEnv: TfEnv, outputs: TfOutputs): DriftIo {
  return {
    fly: (args) => flyJson(args),
    exec: onMachine,
    repoKeys: (repo) => {
      if (!isRepoName(repo)) return null;
      const r = spawnSync('gh', ['api', `repos/${repo}/keys`], { encoding: 'utf8' });
      if (r.status !== 0) return null;
      try {
        return JSON.parse(r.stdout) as RepoKeys;
      } catch {
        return null;
      }
    },
    ingress: async (t) => {
      try {
        const api = cloudflareClient('machine:wall-report (tunnel ingress)');
        const res = await api<{ config?: Ingress }>(
          'GET',
          `/accounts/${t.account_id}/cfd_tunnel/${t.id}/configurations`,
        );
        return res.config ?? null;
      } catch {
        return null;
      }
    },
    expected: (project) => {
      const found = readSettings(project, { outputs: () => outputs, keychainHas, keychainRead });
      return new Map(found.settings.map((s) => [s.name, s.value()]));
    },
    routerVars: () => staticVars(configReader(process.env), CONFIG_PATHS[tfEnv]),
    plan: async () => {
      let out = '';
      const status = await runWrapper(
        'plan',
        { env: tfEnv, ci: true },
        { ...realIo(tfEnv), out: (s) => (out += s), err: (s) => process.stderr.write(s) },
      );
      return { status, summary: out };
    },
  };
}
