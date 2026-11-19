#!/usr/bin/env bun
/**
 * `bun run fly:ci-tokens plan|apply [--drop]`: one Fly token per app CI
 * deploys, each cut down from the org token to that one app, written to a
 * GitHub Environment of its own by the `fly-ci/` Terraform root
 * (infra/cloudflare/README.md, "Fly's CI tokens").
 *
 *   project machines  `cw-<project>` for each entry of machines.json, into
 *                     the environment `fly-<project>` (fly.yml)
 *   the staging trial `cw-appkit-trial-staging`, into `fly-appkit-staging`
 *                     (app-kit-staging.yml)
 *
 * Each token is made by `fly tokens attenuate`, which works offline: no API
 * call and no login. Its caveats (`caveats`) allow the one app with the
 * actions a deploy takes, the org feature `builder` (Fly's remote builder)
 * and nothing else, so no `wg` (WireGuard, which `fly ssh` rides),
 * `deletion` or `membership`, and expire it after VALID_DAYS. Fly needs the
 * app's numeric id for that, read once per app from Fly's API with the org
 * token; an app the org does not have is skipped until fly-provision.yml
 * makes it.
 *
 * With CW_HANDOFF_OUT set (an apply in fly-ci-tokens.yml) it also cuts one
 * token per project app for the Mac's own `fly` calls (`macCaveats`: the app
 * with `builder` and `wg`, so `fly ssh` works, for MAC_VALID_DAYS) and seals
 * them to the Mac (`infra/handoff/`), which stores them on its next
 * `handoff:pull`. This is what replaced the keeper's routine `fly` calls,
 * its `fly logs` and its board moves.
 *
 *   GITHUB_TOKEN   a classic token with repo scope, for the GitHub provider
 *                  (fly-org's GH_ADMIN_TOKEN)
 *   FLY_API_TOKEN  the org token: only fly-org holds it since the keeper retired
 *
 * The org token goes to `fly`'s environment and to Fly's API, and nowhere
 * else. Each cut token goes from `fly`'s stdout into terraform's environment
 * (TF_VAR_deploy_tokens) and nowhere else: never an argument, a file this
 * writes, or a printed line. The state and the saved plan hold them, so the
 * state is local, in `$CW_TF_WORK_DIR/fly-ci` (the runner's temp folder in
 * CI, so each run starts from none and GitHub's upsert writes every secret
 * again) or `~/.local/state/claude-workspaces/fly-ci/`, mode 700, and the
 * plan is removed when the run ends. fly-ci-tokens.yml applies weekly, so
 * every token is cut fresh well inside its window; nothing needs a person.
 *
 * An apply whose plan deletes anything is refused unless `--drop` is given:
 * an app missing from this run would otherwise delete its environment.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deletions } from '../cloudflare/ci-secrets.ts';
import { planSummary } from '../cloudflare/plan-summary.ts';
import { FLY_CI_DIR, type TfResult, spawnTerraform } from '../cloudflare/terraform.ts';
import { type HandoffSink, macSinkFromEnv, recipientKey } from '../handoff/items.ts';
import { HANDOFF_REPO as CI_REPO } from '../handoff/mac-store.ts';
import { MACHINES_FILE, parseMachines } from './machines.ts';

/** The app-kit-staging trial's one app, and its environment. */
export const STAGING_APP = 'cw-appkit-trial-staging';
export const STAGING_ENVIRONMENT = 'fly-appkit-staging';
/** The environment a project machine's deploy job runs in (fly.yml). */
export const environmentFor = (project: string): string => `fly-${project}`;

export interface Target {
  environment: string;
  app: string;
}

/** Every app CI deploys, with the environment its token goes to. */
export function targets(projects: readonly string[]): Target[] {
  return [
    ...projects.map((p) => ({ environment: environmentFor(p), app: `cw-${p}` })),
    { environment: STAGING_ENVIRONMENT, app: STAGING_APP },
  ];
}

/** Read, write, create, delete and control: what `fly deploy` does to its app. */
export const DEPLOY_ACTIONS = 'rwcdC';
/** The org features a cut token keeps. `builder` is Fly's remote builder. */
export const FEATURES = ['builder'] as const;
/** Org features a CI token must never carry: `wg` is the door `fly ssh` uses. */
export const NEVER_FEATURES = ['wg', 'deletion', 'membership', 'billing'] as const;
export const VALID_DAYS = 90;
/** The Mac's tokens are cut weekly, so two weeks leaves one missed run of slack. */
export const MAC_VALID_DAYS = 14;
/** What the Mac's token adds: `wg`, the door `fly ssh` (board moves, restores) uses. */
export const MAC_FEATURES = ['builder', 'wg'] as const;

export interface Caveat {
  type: string;
  body: Record<string, unknown>;
}

/**
 * The caveats `fly tokens attenuate` adds (superfly/macaroon,
 * `flyio/caveats.go`): this app alone, the listed features alone, and a
 * window from a minute ago (a clock a little behind Fly's) to VALID_DAYS on.
 */
export function caveats(appId: string, nowMs: number): Caveat[] {
  if (!/^\d+$/.test(appId)) throw new Error('a Fly app id is a number');
  const now = Math.floor(nowMs / 1000);
  return [
    { type: 'Apps', body: { apps: { [appId]: DEPLOY_ACTIONS } } },
    {
      type: 'FeatureSet',
      body: { features: Object.fromEntries(FEATURES.map((f) => [f, DEPLOY_ACTIONS])) },
    },
    {
      type: 'ValidityWindow',
      body: { not_before: now - 60, not_after: now + VALID_DAYS * 86_400 },
    },
  ];
}

/** The Mac's token for one app: the app, the builder and `wg`, for MAC_VALID_DAYS. */
export function macCaveats(appId: string, nowMs: number): Caveat[] {
  const [apps, , window] = caveats(appId, nowMs) as [Caveat, Caveat, Caveat];
  const now = Math.floor(nowMs / 1000);
  return [
    apps,
    {
      type: 'FeatureSet',
      body: { features: Object.fromEntries(MAC_FEATURES.map((f) => [f, DEPLOY_ACTIONS])) },
    },
    { ...window, body: { not_before: now - 60, not_after: now + MAC_VALID_DAYS * 86_400 } },
  ];
}

export interface RunResult {
  status: number;
  stdout: string;
}

export interface CiTokensIo {
  env: Record<string, string | undefined>;
  /** The projects in machines.json. */
  projects: () => string[];
  /** The org token. Throws when there is none. */
  orgToken: () => string;
  /** The app's numeric id, or null when the org has no such app. */
  appId: (app: string, orgToken: string) => Promise<string | null>;
  /** `fly tokens attenuate`, caveats on stdin, the org token in its environment. */
  attenuate: (caveatsJson: string, orgToken: string) => RunResult;
  now: () => number;
  /** Where an apply seals the Mac's tokens; null cuts none. */
  macSink: HandoffSink | null;
  /** The Mac's committed public key (`infra/handoff/recipients.json`). */
  macKey: () => string;
  /** Where the state and the saved plan go, mode 700, each file 600. */
  stateDir: string;
  /** terraform's own folder (providers, backend), beside `stateDir`. */
  dataDir: string;
  /** terraform in `fly-ci/`, `env` added; stdout captured, stderr shown. */
  terraform: (args: string[], env: Record<string, string>) => TfResult;
  removeFile: (path: string) => void;
  out: (s: string) => void;
  err: (s: string) => void;
}

/** A cut token as `fly tokens attenuate` prints it: one line, nothing else. */
const TOKEN_LINE = /^(FlyV1 )?[A-Za-z0-9_+/=,.-]+$/;

export const USAGE = 'usage: bun run fly:ci-tokens plan|apply [--drop]\n';

/** Exit code: 0 done, 1 failed or refused, 2 bad usage. */
export async function ciTokens(argv: string[], io: CiTokensIo): Promise<number> {
  const [mode, ...flags] = argv;
  if ((mode !== 'plan' && mode !== 'apply') || flags.some((f) => f !== '--drop')) {
    io.err(USAGE);
    return 2;
  }
  const drop = flags.includes('--drop');
  const say = (s: string) => io.err(`[fly:ci-tokens] ${s}\n`);
  const githubToken = io.env.GITHUB_TOKEN?.trim() ?? '';
  if (!githubToken) {
    say('GITHUB_TOKEN not set; nothing was run');
    return 1;
  }
  let org: string;
  let list: Target[];
  try {
    list = targets(io.projects());
    org = io.orgToken();
  } catch (e) {
    say(`${e instanceof Error ? e.message : String(e)}; nothing was run`);
    return 1;
  }
  const tokens: Record<string, string> = {};
  let macKey = '';
  if (mode === 'apply' && io.macSink) {
    try {
      macKey = io.macKey();
    } catch (e) {
      say(`${e instanceof Error ? e.message : String(e)}; nothing was run`);
      return 1;
    }
  }
  for (const t of list) {
    let id: string | null;
    try {
      id = await io.appId(t.app, org);
    } catch (e) {
      say(`${t.app}: ${e instanceof Error ? e.message : String(e)}; nothing was run`);
      return 1;
    }
    if (id === null) {
      say(
        `${t.app}: the org has no such app, so ${t.environment} gets no token (and loses one an earlier apply wrote, which apply refuses without --drop); dispatch fly-provision.yml for it first`,
      );
      continue;
    }
    const cut = io.attenuate(JSON.stringify(caveats(id, io.now())), org);
    const token = cut.stdout.trim();
    // An attenuate that printed its input would hand CI the org token.
    if (cut.status !== 0 || !TOKEN_LINE.test(token) || token === org.trim()) {
      say(
        `${t.app}: fly tokens attenuate ${cut.status !== 0 ? `exited ${cut.status}` : 'printed no token'}; nothing was run`,
      );
      return 1;
    }
    tokens[t.environment] = token;
    if (mode === 'apply' && io.macSink && t.app !== STAGING_APP) {
      const forMac = io.attenuate(JSON.stringify(macCaveats(id, io.now())), org);
      const macToken = forMac.stdout.trim();
      if (forMac.status !== 0 || !TOKEN_LINE.test(macToken) || macToken === org.trim()) {
        say(`${t.app}: fly tokens attenuate for the Mac printed no token; nothing was run`);
        return 1;
      }
      const notAfter = Math.floor(io.now() / 1000) + MAC_VALID_DAYS * 86_400;
      io.macSink.add({ kind: 'fly-app-token', app: t.app, token: macToken, notAfter });
    }
    say(
      `${t.environment}: a token for ${t.app} alone, features ${FEATURES.join(', ')}, valid ${VALID_DAYS} days`,
    );
  }
  const [owner, repository] = CI_REPO.split('/') as [string, string];
  const tfEnv: Record<string, string> = {
    GITHUB_TOKEN: githubToken,
    TF_DATA_DIR: io.dataDir,
    TF_INPUT: '0',
    TF_VAR_repository_owner: owner,
    TF_VAR_repository: repository,
    TF_VAR_deploy_tokens: JSON.stringify(tokens),
  };
  const init = io.terraform(
    [
      'init',
      '-input=false',
      '-lockfile=readonly',
      '-reconfigure',
      `-backend-config=path=${join(io.stateDir, 'terraform.tfstate')}`,
    ],
    tfEnv,
  );
  if (init.status !== 0) {
    say(`terraform init exited ${init.status}`);
    return 1;
  }
  const plan = join(io.stateDir, 'fly-ci.tfplan');
  // A run that was killed left its plan, which holds the tokens.
  io.removeFile(plan);
  try {
    const planned = io.terraform(['plan', '-input=false', `-out=${plan}`], tfEnv);
    if (planned.status !== 0) {
      say(`terraform plan exited ${planned.status}`);
      return 1;
    }
    const shown = io.terraform(['show', '-json', plan], tfEnv);
    if (shown.status !== 0) {
      say('terraform show failed');
      return 1;
    }
    io.out(planSummary(shown.stdout, 'fly-ci'));
    if (mode === 'plan') return 0;
    const gone = deletions(shown.stdout);
    if (gone.length && !drop) {
      say(
        `the plan deletes ${gone.join(', ')}: an app this run did not find. Make it, or pass --drop to delete on purpose; nothing was applied`,
      );
      return 1;
    }
    const applied = io.terraform(['apply', '-input=false', plan], tfEnv);
    if (applied.status !== 0) {
      say(`terraform apply exited ${applied.status}`);
      return 1;
    }
    io.out('Applied. GitHub holds the tokens the plan above names; no value was printed.\n');
    if (io.macSink?.flush(macKey)) {
      io.out(`Sealed to the Mac: ${io.macSink.describe().join('; ')}.\n`);
    }
    return 0;
  } finally {
    io.removeFile(plan);
  }
}

/** Fly's GraphQL answer for an app. A FlyV1 token is sent as is, any other as Bearer. */
export async function flyAppId(
  app: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  url = 'https://api.fly.io/graphql',
): Promise<string | null> {
  const auth = token.startsWith('FlyV1 ') ? token : `Bearer ${token}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query($name: String!) { app(name: $name) { internalNumericId } }',
      variables: { name: app },
    }),
  });
  if (!res.ok) throw new Error(`Fly's API answered ${res.status}`);
  const body = (await res.json()) as {
    data?: { app?: { internalNumericId?: unknown } | null } | null;
    errors?: Array<{ message?: unknown }>;
  };
  const id = body.data?.app?.internalNumericId;
  if (typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id))) return String(id);
  const messages = (body.errors ?? []).map((e) => String(e.message ?? ''));
  if (messages.some((m) => /could not find|not found/i.test(m))) return null;
  throw new Error(`Fly's API gave no id for ${app}`);
}

/** `fly tokens attenuate`: caveats on stdin, the parent token in the child's environment only. */
export function attenuateWithFly(caveatsJson: string, orgToken: string, bin = 'fly'): RunResult {
  const r = spawnSync(bin, ['tokens', 'attenuate'], {
    input: caveatsJson,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, FLY_API_TOKEN: orgToken },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

/** FLY_API_TOKEN: the org token, which only the fly-org environment holds. */
export function orgTokenFrom(env: Record<string, string | undefined>): string {
  const set = env.FLY_API_TOKEN?.trim();
  if (set) return set;
  throw new Error(
    'FLY_API_TOKEN is not set: the org token lives only in the fly-org environment, so this runs in fly-ci-tokens.yml',
  );
}

if (import.meta.main) {
  // Outside every checkout: a worktree is deleted when its branch is done.
  const work = process.env.CW_TF_WORK_DIR?.trim();
  const stateDir = work
    ? join(work, 'fly-ci')
    : join(homedir(), '.local', 'state', 'claude-workspaces', 'fly-ci');
  const dataDir = `${stateDir}-data`;
  for (const d of [stateDir, dataDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  ciTokens(process.argv.slice(2), {
    env: process.env,
    projects: () => parseMachines(readFileSync(MACHINES_FILE, 'utf8')).map((m) => m.project),
    orgToken: () => orgTokenFrom(process.env),
    macSink: macSinkFromEnv(process.env),
    macKey: () => recipientKey('mac'),
    appId: (app, token) => flyAppId(app, token),
    attenuate: (json, token) => attenuateWithFly(json, token),
    now: Date.now,
    stateDir,
    dataDir,
    terraform: (args, env) => spawnTerraform(FLY_CI_DIR, args, env, true, stateDir),
    removeFile: (p) => rmSync(p, { force: true }),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  }).then((code) => process.exit(code));
}
