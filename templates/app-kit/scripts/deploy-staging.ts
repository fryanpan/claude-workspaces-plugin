#!/usr/bin/env bun
/**
 * `bun run deploy:staging [app] [--region <r>] [--url <u>] [--started-at <ms>] [--dry-run]`:
 * put this app on Fly at https://<app>.fly.dev and wait until it answers.
 *
 *   app        default `<package name>-staging`. Any name must end in
 *              `-staging`, the suffix new-app gives every staging app, so a
 *              deploy cannot land on an app in the org that is not one.
 *   --region   where the app, its volume and its machine go; default sjc
 *   --url      the address to wait on; default https://<app>.fly.dev/health
 *   --started-at  when the timed run began, in epoch ms; default now. The
 *              app-kit-staging workflow passes the time before `new-app`.
 *   --dry-run  print the `fly` commands, run none, read no credential
 *
 * Steps: make the Fly app if it does not answer `fly status` and the org has
 * none by that name (a token cut down to one app, as the app-kit-staging
 * workflow's is, cannot list the org, so an app that answers is never looked
 * for there), make its data
 * volume if it has none, set AUTH_SECRET once (made here, sent on stdin,
 * never printed), deploy with APP_URL set to the app's origin, then poll the
 * URL until it answers 200 and print the time since the command started.
 *
 * Credentials: FLY_API_TOKEN and FLY_ORG from the environment, and nowhere
 * else: the Keychain is never read, because the Fly org token now lives only
 * in CI (claude-workspaces' docs/process/keeper.md, "Retired"). With no
 * FLY_ORG, the org is the one `fly orgs list` returns, when the token reaches
 * exactly one. The token goes into the `fly` child's environment and nowhere
 * else: never an argument, a log line or a file. In the claude-workspaces
 * repo CI holds a token for the trial app alone, so deploys run from the
 * `app-kit-staging` workflow (.github/workflows/app-kit-staging.yml).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** Fly's rule for an app name: what `app` may be. */
const APP_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** The suffix new-app gives a staging app (`<dir name>-staging`); the only apps this deploys to. */
export const STAGING_SUFFIX = '-staging';
const REGION = /^[a-z]{3}$/;
/** fly.toml's `[mounts] source`. */
export const VOLUME = 'app_data';
const POLL_EVERY_MS = 2_000;
const POLL_FOR_MS = 15 * 60_000;

export interface Options {
  app: string;
  region: string;
  url: string;
  dryRun: boolean;
  /** Epoch ms the timed run began; undefined means when this command began. */
  startedAt?: number;
}

export function parseArgs(argv: string[], pkgName: string): Options {
  let app = `${pkgName}-staging`;
  let region = 'sjc';
  let url: string | undefined;
  let dryRun = false;
  let startedAt: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--region') region = argv[++i] ?? '';
    else if (arg === '--url') url = argv[++i] ?? '';
    else if (arg === '--started-at') {
      startedAt = Number(argv[++i]);
      if (!Number.isSafeInteger(startedAt) || startedAt <= 0) {
        throw new Error('--started-at takes epoch milliseconds');
      }
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else app = arg;
  }
  if (!APP_NAME.test(app)) throw new Error(`not a Fly app name: ${JSON.stringify(app)}`);
  if (!app.endsWith(STAGING_SUFFIX)) {
    throw new Error(
      `refusing to deploy to ${JSON.stringify(app)}: not a staging app. This deploys only to apps whose name ends in "${STAGING_SUFFIX}", the name new-app gives one, so it cannot overwrite another app in the org`,
    );
  }
  if (!REGION.test(region)) throw new Error(`not a Fly region: ${JSON.stringify(region)}`);
  return { app, region, url: url || `https://${app}.fly.dev/health`, dryRun, startedAt };
}

export interface Credentials {
  token: string;
  /** Undefined when FLY_ORG is unset: see `resolveOrg`. */
  org?: string;
}

const WHERE_DEPLOYS_RUN =
  'set FLY_API_TOKEN, or deploy from the app-kit-staging workflow in the claude-workspaces repo';

/** FLY_API_TOKEN and FLY_ORG from the environment; the token is required. */
export function credentials(env: Record<string, string | undefined>): Credentials {
  const token = env.FLY_API_TOKEN?.trim();
  if (!token) throw new Error(WHERE_DEPLOYS_RUN);
  return { token, org: env.FLY_ORG?.trim() || undefined };
}

/** The org slugs in `fly orgs list --json`: a slug-to-name map, or rows with a slug. */
function orgSlugs(json: string): string[] {
  const parsed = JSON.parse(json || '{}') as unknown;
  if (Array.isArray(parsed)) {
    return parsed.map((row: Record<string, unknown>) => String(row.Slug ?? row.slug ?? ''));
  }
  return Object.keys(parsed as Record<string, unknown>);
}

/** `org` when given, else the one org the token reaches; refuses zero or several. */
export function resolveOrg(fly: Fly, org: string | undefined): string {
  if (org) return org;
  const slugs = orgSlugs(ok(fly, ['orgs', 'list', '--json'])).filter(Boolean);
  if (slugs.length === 1) return slugs[0] as string;
  throw new Error(
    `FLY_ORG is not set and the token reaches ${slugs.length} Fly orgs; set FLY_ORG to one of them`,
  );
}

export interface FlyResult {
  status: number;
  stdout: string;
}

/** One `fly` command. `input` is its stdin; `live` shows its output here. */
export type Fly = (args: string[], opts?: { input?: string; live?: boolean }) => FlyResult;

/** `fly`, run in the app's folder (the build context), with the token in its environment only. */
export function realFly(token: string): Fly {
  return (args, opts = {}) => {
    const r = spawnSync('fly', args, {
      cwd: ROOT,
      encoding: 'utf8',
      input: opts.input,
      stdio: [
        opts.input === undefined ? 'inherit' : 'pipe',
        opts.live ? 'inherit' : 'pipe',
        'inherit',
      ],
      env: { ...process.env, FLY_API_TOKEN: token },
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? '' };
  };
}

/** Prints each command, runs none; no app answers, and every list it is asked for is empty. */
export function dryRunFly(log: (line: string) => void): Fly {
  return (args, opts = {}) => {
    const stdin = opts.input === undefined ? '' : ` <<< ${redact(opts.input)}`;
    log(`fly ${args.join(' ')}${stdin}`);
    return { status: args[0] === 'status' ? 1 : 0, stdout: '[]' };
  };
}

/** `NAME=value` lines with every value hidden. */
const redact = (input: string): string =>
  input
    .trim()
    .split('\n')
    .map((line) => `${line.split('=')[0]}=<redacted>`)
    .join(' ');

function ok(fly: Fly, args: string[], opts?: { input?: string; live?: boolean }): string {
  const r = fly(args, opts);
  if (r.status !== 0) throw new Error(`fly ${args.slice(0, 2).join(' ')} exited ${r.status}`);
  return r.stdout;
}

/** The `name` field of each row of a `--json` list; flyctl spells it either way. */
function names(json: string): string[] {
  const rows = JSON.parse(json || '[]') as Array<Record<string, unknown>>;
  return rows.map((row) => String(row.Name ?? row.name ?? ''));
}

export interface Deps {
  fly: Fly;
  /** Undefined: the one org the token reaches (`resolveOrg`). */
  org?: string;
  log: (line: string) => void;
  /** When the command started; `opts.startedAt` wins when given. */
  startedAt: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Make what is missing, deploy, and (unless a dry run) wait for a 200. */
export async function deployStaging(opts: Options, deps: Deps): Promise<void> {
  const { fly, log } = deps;
  const { app, region } = opts;
  const origin = `https://${app}.fly.dev`;

  // Asked of the app first: a token for this app alone cannot list the org.
  if (fly(['status', '--app', app, '--json']).status !== 0) {
    const org = resolveOrg(fly, deps.org);
    if (!names(ok(fly, ['apps', 'list', '--org', org, '--json'])).includes(app)) {
      log(`making Fly app ${app}`);
      ok(fly, ['apps', 'create', app, '--org', org]);
    }
  }
  if (JSON.parse(ok(fly, ['volumes', 'list', '--app', app, '--json']) || '[]').length === 0) {
    ok(fly, [
      'volumes',
      'create',
      VOLUME,
      '--app',
      app,
      '--region',
      region,
      '--size',
      '1',
      '--yes',
    ]);
  }
  if (!names(ok(fly, ['secrets', 'list', '--app', app, '--json'])).includes('AUTH_SECRET')) {
    const secret = randomBytes(32).toString('base64url');
    ok(fly, ['secrets', 'import', '--app', app, '--stage'], { input: `AUTH_SECRET=${secret}\n` });
  }
  ok(
    fly,
    [
      'deploy',
      '--app',
      app,
      '--config',
      'fly.toml',
      '--primary-region',
      region,
      '--remote-only',
      '--ha=false',
      '--env',
      `APP_URL=${origin}`,
      '--env',
      'APP_ENV=staging',
    ],
    { live: true },
  );

  if (opts.dryRun) {
    log(`dry run: would wait for ${opts.url} to answer 200`);
    return;
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + POLL_FOR_MS;
  for (;;) {
    const status = await fetch(opts.url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    }).then(
      (r) => r.status,
      () => 0,
    );
    if (status === 200) break;
    if (now() > deadline) throw new Error(`${opts.url} still answers ${status || 'nothing'}`);
    await sleep(POLL_EVERY_MS);
  }
  const s = Math.round((now() - (opts.startedAt ?? deps.startedAt)) / 1000);
  const line = `${origin} answers 200, ${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s after the command started`;
  log(line);
  // In a GitHub Actions run, the elapsed time also goes on the run's page.
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${line}\n`);
}

if (import.meta.main) {
  const startedAt = Date.now();
  const log = (line: string): void => console.log(line);
  try {
    const pkg = (await Bun.file(join(ROOT, 'package.json')).json()) as { name: string };
    const opts = parseArgs(process.argv.slice(2), pkg.name);
    if (opts.dryRun) {
      const org = process.env.FLY_ORG?.trim() || '<org>';
      log('dry run: no fly command runs, and every list is taken as empty');
      await deployStaging(opts, { fly: dryRunFly(log), org, log, startedAt });
    } else {
      const { token, org } = credentials(process.env);
      await deployStaging(opts, { fly: realFly(token), org, log, startedAt });
    }
  } catch (err) {
    console.error(String((err as Error).message ?? err));
    process.exit(1);
  }
}
