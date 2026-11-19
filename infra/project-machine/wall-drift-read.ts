/**
 * Reads what the drift checks judge (`wall-drift.ts`), for `wall-report.ts`.
 * Every read is a read: `fly apps|ips|machine list`, `fly ssh console`
 * running `wall-probe.ts machine`, GitHub's deploy-key list, this repo's
 * environments with their secret names, update times and branch rules (never
 * a value), the tunnel's configuration and the live Access applications and
 * service token names from Cloudflare's API (read-only token,
 * `readOnlyCloudflare`), the deploy's settings (`settings.ts`, Keychain and
 * Terraform outputs), the router config, and a Cloudflare plan that holds no
 * lock and applies nothing.
 */
import { spawnSync } from 'node:child_process';
import { isRepoName } from '../../packages/server/src/git-push/policy.ts';
import { CI_REPO } from '../../packages/server/src/keeper/keeper-github.ts';
import type { TfOutputs } from '../cloudflare/outputs.ts';
import { realIo, runWrapper } from '../cloudflare/run.ts';
import { configReader } from '../cloudflare/run.ts';
import type { TfEnv } from '../cloudflare/terraform.ts';
import { CONFIG_PATHS, type StaticVars, staticVars } from '../cloudflare/vars.ts';
import { STAGING_ENVIRONMENT, environmentFor } from './ci-tokens.ts';
import { cloudflareApi } from './cloudflare.ts';
import { flyJson, keychainHas, keychainRead, onMachine } from './mac-ops.ts';
import type { MachineFacts } from './machine-facts.ts';
import { readSettings } from './settings.ts';
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

export interface DriftIo {
  fly: <T>(args: string[]) => T;
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
 * The daily report's Cloudflare credentials: a read-only API token and the
 * state bucket's read-only key, the same pair CI's pull request plans hold
 * (infra/cloudflare/README.md, "CI"). There is no fallback to the apply
 * token or the read-write state key: a missing entry stops the report.
 */
export const READ_TOKEN_ENTRY = 'cloudflare-api-token-read';
export const READ_STATE_ENTRY = 'cloudflare-r2-tfstate-read';

export interface ReadOnlyCloudflare {
  token: string;
  /** The state bucket's read-only key, as terraform's S3 backend reads it. */
  state: { AWS_ACCESS_KEY_ID: string; AWS_SECRET_ACCESS_KEY: string };
}

export function readOnlyCloudflare(src: {
  keychainHas: (name: string) => boolean;
  keychainRead: (name: string) => string;
}): ReadOnlyCloudflare {
  for (const entry of [READ_TOKEN_ENTRY, READ_STATE_ENTRY])
    if (!src.keychainHas(entry))
      throw new Error(
        `the Keychain has no ${entry}; the wall report reads Cloudflare with read-only credentials only`,
      );
  let pair: { accessKeyId?: unknown; secretAccessKey?: unknown } = {};
  try {
    pair = JSON.parse(src.keychainRead(READ_STATE_ENTRY));
  } catch {
    // Refused below.
  }
  if (typeof pair.accessKeyId !== 'string' || typeof pair.secretAccessKey !== 'string')
    throw new Error(
      `the Keychain entry ${READ_STATE_ENTRY} has no accessKeyId and secretAccessKey`,
    );
  return {
    token: src.keychainRead(READ_TOKEN_ENTRY).trim(),
    state: { AWS_ACCESS_KEY_ID: pair.accessKeyId, AWS_SECRET_ACCESS_KEY: pair.secretAccessKey },
  };
}

export function realDriftIo(tfEnv: TfEnv, outputs: TfOutputs, ro: ReadOnlyCloudflare): DriftIo {
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
        const res = await cloudflareApi(ro.token)<{ config?: Ingress }>(
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
    github: () => readGithub(CI_REPO, ghJson),
    accessApps: async () => {
      const account = Object.values(outputs.tunnels)[0]?.account_id;
      if (!account || !/^[0-9a-f]{32}$/.test(account)) return null;
      try {
        const api = cloudflareApi(ro.token);
        const apps = await api.all<LiveAccessApp>(`/accounts/${account}/access/apps`);
        const tokens = await api.all<{ id?: unknown; name?: unknown }>(
          `/accounts/${account}/access/service_tokens`,
        );
        return { apps, tokenNames: new Map(tokens.map((t) => [String(t.id), String(t.name)])) };
      } catch {
        return null;
      }
    },
    namePrefix: tfEnv === 'staging' ? 'staging ' : '',
    now: Date.now,
    plan: async () => {
      let out = '';
      const status = await runWrapper(
        'plan',
        { env: tfEnv, ci: true },
        {
          ...realIo(tfEnv),
          // tfCredentials takes these before any Keychain entry.
          env: { ...process.env, CLOUDFLARE_API_TOKEN: ro.token, ...ro.state },
          out: (s) => (out += s),
          err: (s) => process.stderr.write(s),
        },
      );
      return { status, summary: out };
    },
  };
}
