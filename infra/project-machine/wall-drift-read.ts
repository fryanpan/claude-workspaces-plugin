/**
 * Reads what the drift checks judge (`wall-drift.ts`), for `wall-report.ts`.
 * Every read is a read. On the Mac: `fly ips|machine list` and `fly ssh
 * console` running `wall-probe.ts machine`, each with the app's own token;
 * GitHub's deploy-key list and this repo's environments with their secret
 * names, update times and branch rules (never a value), through `gh`; the
 * deploy's settings (`settings.ts`: the Terraform outputs and the owner's
 * address, the one Keychain entry read); and the router config. From CI's
 * sealed read (`wall-read.ts`), because each needs a credential only CI
 * holds: `fly apps list`, the tunnels' configurations, the live Access
 * applications and service token names, and a Cloudflare plan that holds no
 * lock and applies nothing.
 */
import { spawnSync } from 'node:child_process';
import { isRepoName } from '../../packages/server/src/git-push/policy.ts';
import { CI_REPO } from '../../packages/server/src/provisioning/github-ci.ts';
import type { TfOutputs } from '../cloudflare/outputs.ts';
import { configReader } from '../cloudflare/run.ts';
import type { TfEnv } from '../cloudflare/terraform.ts';
import { CONFIG_PATHS, type StaticVars, staticVars } from '../cloudflare/vars.ts';
import { STAGING_ENVIRONMENT, environmentFor } from './ci-tokens.ts';
import { flyJson, keychainHas, keychainRead, onMachine } from './mac-ops.ts';
import type { MachineFacts } from './machine-facts.ts';
import { type Machine, readMachines } from './machines.ts';
import { OWNER_EMAIL_ENTRY, SETTING_NAMES, readSettings } from './settings.ts';
import {
  type FlyView,
  type GithubEnvironment,
  type GithubView,
  type Ingress,
  type LiveAccessApp,
  PROBE,
  type RepoKeys,
  type Row,
  appFor,
  ciTokenRows,
  deployKeyRepos,
  deployKeyRows,
  flyRows,
  gitPushRows,
  ingressRows,
  lastJson,
  liveAccessRows,
  oneAddressRows,
  planRows,
  serviceTokenRows,
  settingsRows,
  uidRows,
} from './wall-drift.ts';
import { leadRows } from './wall-lead-rows.ts';
import type { CloudflareRead, FlyRead } from './wall-read.ts';

export interface DriftIo {
  /** `fly ips|machine list --app <app>`, with that app's own token. */
  fly: <T>(args: string[]) => T;
  /** `fly apps list`, as CI read it with the org token; null when there is no read. */
  apps: () => FlyView['apps'] | null;
  exec: (app: string, command: string) => string;
  repoKeys: (repo: string) => RepoKeys;
  ingress: (tunnel: TfOutputs['tunnels'][string]) => Promise<Ingress | null>;
  /** What `machine:deploy` would set on the project's server, by name. */
  expected: (project: string) => Map<string, string>;
  routerVars: () => StaticVars;
  plan: () => Promise<{ status: number; summary: string }>;
  /** This repo's environments and secret names (`readGithub`). */
  github: () => GithubView;
  /** The live Access applications, and each service token's name by id; null when unread. */
  accessApps: () => Promise<{ apps: LiveAccessApp[]; tokenNames: Map<string, string> } | null>;
  /** The committed project list, for its lead-token pins and Remote Control (`wall-lead-rows.ts`). */
  machines: () => Machine[];
  /** The environment's Access `name_prefix`: "" for prod. */
  namePrefix: string;
  now: () => number;
}

export async function driftRows(
  projects: readonly string[],
  outputs: TfOutputs,
  io: DriftIo,
): Promise<Row[]> {
  const rows: Row[] = [];
  const apps = io.apps();
  if (apps === null)
    rows.push({
      project: '(all)',
      check: 'fly apps list',
      answer: 'no CI read of it, so no app is found in it',
      ok: false,
    });
  const view: FlyView = { apps: apps ?? [], ips: {}, machines: {} };
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
  const leads = new Map<string, MachineFacts['lead']>();
  for (const p of projects) {
    let facts: MachineFacts;
    try {
      facts = lastJson<MachineFacts>(io.exec(appFor(p), `${PROBE} machine`));
    } catch {
      rows.push({ project: p, check: 'machine probe', answer: 'did not answer', ok: false });
      continue;
    }
    leads.set(p, facts.lead);
    rows.push(...settingsRows(p, io.expected(p), facts));
    rows.push(...uidRows(p, facts));
    rows.push(...gitPushRows(p, facts));
    const keys: Record<string, RepoKeys> = {};
    if (facts.deployKey) for (const r of deployKeyRepos(facts)) keys[r] = io.repoKeys(r);
    rows.push(...deployKeyRows(p, facts, keys));
    const t = outputs.tunnels[p];
    rows.push(...ingressRows(p, t?.public_host, t ? await io.ingress(t) : null, facts));
  }
  rows.push(...leadRows(io.machines(), leads));
  rows.push(
    ...ciTokenRows(
      [
        ...projects.map((p) => ({ project: p, environment: environmentFor(p) })),
        { project: '(staging)', environment: STAGING_ENVIRONMENT },
      ],
      io.github(),
      io.now(),
    ),
  );
  try {
    const v = io.routerVars();
    rows.push(...oneAddressRows(v), ...serviceTokenRows(v.access_projects));
    const live = await io.accessApps();
    rows.push(
      ...liveAccessRows(
        v.access_projects,
        live?.apps ?? null,
        live?.tokenNames ?? new Map(),
        io.namePrefix,
      ),
    );
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

/** `gh api <path>`, parsed, or null when it failed. */
export type GhRead = (path: string) => unknown;

const ENV_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The repo's environments, each with its secret names and update times and
 * whether it admits main alone, and the repository's own secret names.
 * GitHub returns names and times for secrets, never a value.
 */
export function readGithub(repo: string, gh: GhRead): GithubView {
  type Listed = {
    name?: unknown;
    deployment_branch_policy?: { protected_branches?: unknown; custom_branch_policies?: unknown };
  };
  const list = gh(`repos/${repo}/environments?per_page=100`) as { environments?: Listed[] } | null;
  const own = gh(`repos/${repo}/actions/secrets?per_page=100`) as {
    secrets?: Array<{ name?: unknown }>;
  } | null;
  const environments = list?.environments
    ? list.environments.map((e): GithubEnvironment => {
        const name = String(e.name ?? '');
        // A name that cannot go in a path is reported unread, never skipped.
        if (!ENV_NAME.test(name)) return { name, secrets: null, mainOnly: null };
        const base = `repos/${repo}/environments/${name}`;
        const listed = gh(`${base}/secrets?per_page=100`) as {
          secrets?: Array<{ name?: unknown; updated_at?: unknown }>;
        } | null;
        const policy = e.deployment_branch_policy;
        const rules = policy?.custom_branch_policies
          ? (gh(`${base}/deployment-branch-policies`) as {
              branch_policies?: Array<{ name?: unknown; type?: unknown }>;
            } | null)
          : null;
        const mainOnly =
          policy?.custom_branch_policies !== true || policy.protected_branches === true
            ? false
            : rules?.branch_policies
              ? rules.branch_policies.length === 1 &&
                rules.branch_policies[0]?.name === 'main' &&
                (rules.branch_policies[0]?.type ?? 'branch') === 'branch'
              : null;
        return {
          name,
          secrets: listed?.secrets
            ? listed.secrets.map((x) => ({
                name: String(x.name ?? ''),
                ...(typeof x.updated_at === 'string' ? { updated_at: x.updated_at } : {}),
              }))
            : null,
          mainOnly,
        };
      })
    : null;
  return {
    environments,
    repoSecrets: own?.secrets ? own.secrets.map((x) => String(x.name ?? '')) : null,
  };
}

/** `gh api`, parsed; null when it failed or did not parse. */
function ghJson(path: string): unknown {
  const r = spawnSync('gh', ['api', path], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout) as unknown;
  } catch {
    return null;
  }
}

/**
 * Settings the report compares (`SETTING_NAMES`) come from the Terraform
 * outputs and the owner's address. The Keychain is asked for that one entry
 * and no other: the sign-in secrets are never compared, so never read.
 */
export const ownerEmailOnly = (src: {
  keychainHas: (name: string) => boolean;
  keychainRead: (name: string) => string;
}) => ({
  keychainHas: (name: string) => name === OWNER_EMAIL_ENTRY && src.keychainHas(name),
  keychainRead: (name: string) => {
    if (name !== OWNER_EMAIL_ENTRY) throw new Error(`the wall report does not read ${name}`);
    return src.keychainRead(name);
  },
});

/**
 * The Mac's reads. Cloudflare's half, and `fly apps list`, come from CI's
 * sealed read (`wall-read.ts`, `wall-read-pull.ts`); `fly` per app and
 * `fly ssh` use the app's own token (`mac-ops.ts`); GitHub uses `gh`.
 */
export function realDriftIo(
  tfEnv: TfEnv,
  outputs: TfOutputs,
  cf: CloudflareRead,
  fly: FlyRead | null,
): DriftIo {
  return {
    fly: (args) => flyJson(args),
    apps: () => fly?.apps ?? null,
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
    ingress: async (t) => cf.ingress[t.id] ?? null,
    expected: (project) => {
      const found = readSettings(project, {
        outputs: () => outputs,
        ...ownerEmailOnly({ keychainHas, keychainRead }),
      });
      return new Map(
        found.settings
          .filter((s) => (SETTING_NAMES as readonly string[]).includes(s.name))
          .map((s) => [s.name, s.value()]),
      );
    },
    routerVars: () => staticVars(configReader(process.env), CONFIG_PATHS[tfEnv]),
    github: () => readGithub(CI_REPO, ghJson),
    accessApps: async () =>
      cf.access ? { apps: cf.access.apps, tokenNames: new Map(cf.access.tokenNames) } : null,
    machines: readMachines,
    namePrefix: tfEnv === 'staging' ? 'staging ' : '',
    now: Date.now,
    plan: async () => cf.plan,
  };
}
