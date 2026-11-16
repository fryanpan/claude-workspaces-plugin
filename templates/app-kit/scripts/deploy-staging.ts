#!/usr/bin/env bun
/**
 * `bun run deploy:staging [app] [--region <r>] [--url <u>] [--dry-run]`:
 * put this app on Fly at https://<app>.fly.dev and wait until it answers.
 *
 *   app        default `<package name>-staging`
 *   --region   where the app, its volume and its machine go; default sjc
 *   --url      the address to wait on; default https://<app>.fly.dev/health
 *   --dry-run  print the `fly` commands, run none, read no credential
 *
 * Steps: make the Fly app if the org has none by that name, make its data
 * volume if it has none, set AUTH_SECRET once (made here, sent on stdin,
 * never printed), deploy with APP_URL set to the app's origin, then poll the
 * URL until it answers 200 and print the time since the command started.
 *
 * Credentials: FLY_API_TOKEN and FLY_ORG from the environment. On a Mac,
 * either one that is missing is read from the Keychain entries
 * `fly-org-token` and `fly-org-slug`, stored the way the claude-workspaces
 * repo stores them (`packages/core/src/secret-name.ts`). The token goes into
 * the `fly` child's environment and nowhere else: never an argument, a log
 * line or a file.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** Fly's rule for an app name: what `app` may be. */
const APP_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const REGION = /^[a-z]{3}$/;
/** fly.toml's `[mounts] source`. */
export const VOLUME = 'app_data';
const POLL_EVERY_MS = 2_000;
const POLL_FOR_MS = 15 * 60_000;

/** Where the claude-workspaces repo stores a Keychain secret (secret-name.ts). */
export const KEYCHAIN_ACCOUNT = 'claude-workspaces';
export const keychainService = (name: string): string => `claude-workspaces-secret.${name}`;

export interface Options {
  app: string;
  region: string;
  url: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[], pkgName: string): Options {
  let app = `${pkgName}-staging`;
  let region = 'sjc';
  let url: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--region') region = argv[++i] ?? '';
    else if (arg === '--url') url = argv[++i] ?? '';
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else app = arg;
  }
  if (!APP_NAME.test(app)) throw new Error(`not a Fly app name: ${JSON.stringify(app)}`);
  if (!REGION.test(region)) throw new Error(`not a Fly region: ${JSON.stringify(region)}`);
  return { app, region, url: url || `https://${app}.fly.dev/health`, dryRun };
}

/** A Keychain entry as the repo stores it: base64 under one account. */
export function keychainRead(name: string, security = 'security'): string {
  const r = spawnSync(
    security,
    ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', keychainService(name), '-w'],
    { encoding: 'utf8', env: process.env },
  );
  if (r.status !== 0) throw new Error(`the Keychain has no entry ${name}`);
  return Buffer.from(r.stdout.trim(), 'base64').toString('utf8').trim();
}

export interface Credentials {
  token: string;
  org: string;
}

/** FLY_API_TOKEN and FLY_ORG, each from the Keychain on a Mac when unset. */
export function credentials(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
  security?: string,
): Credentials {
  const fromKeychain = (entry: string, variable: string): string => {
    if (platform !== 'darwin') throw new Error(`set ${variable}`);
    return keychainRead(entry, security);
  };
  return {
    token: env.FLY_API_TOKEN?.trim() || fromKeychain('fly-org-token', 'FLY_API_TOKEN'),
    org: env.FLY_ORG?.trim() || fromKeychain('fly-org-slug', 'FLY_ORG'),
  };
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

/** Prints each command, runs none; every list it is asked for is empty. */
export function dryRunFly(log: (line: string) => void): Fly {
  return (args, opts = {}) => {
    const stdin = opts.input === undefined ? '' : ` <<< ${redact(opts.input)}`;
    log(`fly ${args.join(' ')}${stdin}`);
    return { status: 0, stdout: '[]' };
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
  org: string;
  log: (line: string) => void;
  /** When the command started, for the elapsed time it prints. */
  startedAt: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Make what is missing, deploy, and (unless a dry run) wait for a 200. */
export async function deployStaging(opts: Options, deps: Deps): Promise<void> {
  const { fly, log } = deps;
  const { app, region } = opts;
  const origin = `https://${app}.fly.dev`;

  if (!names(ok(fly, ['apps', 'list', '--org', deps.org, '--json'])).includes(app)) {
    log(`making Fly app ${app}`);
    ok(fly, ['apps', 'create', app, '--org', deps.org]);
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
  const s = Math.round((now() - deps.startedAt) / 1000);
  log(
    `${origin} answers 200, ${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s after the command started`,
  );
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
