/**
 * The Mac side of the deploy scripts: the Keychain, and `fly` run with the
 * org token in its environment.
 *
 * Off the Mac (CI, `.github/workflows/cloudflare.yml`) every Keychain entry
 * can be handed in instead as the environment variable `secretEnvName(entry)`
 * (`fly-org-slug` -> CW_SECRET_FLY_ORG_SLUG), plain rather than base64, and
 * the org token as FLY_API_TOKEN. With CW_SECRETS_FROM_ENV=1 the Keychain is
 * never asked at all, and no entry can be made, so a project's first deploy,
 * which makes its backup key and bucket credential, has to run on the Mac.
 *
 * Every value read from the Keychain goes into a child's environment or
 * stdin and nowhere else: never an argument (`ps` shows arguments to every
 * user), never a log line, never a file. Values are stored base64-encoded on
 * stdin, the same way the server's own secret store writes them
 * (`packages/server/src/secret-store.ts`). `security` is found on the PATH
 * this process has now (Bun's `spawnSync` otherwise uses the PATH it started
 * with), so a test's stand-in is the one that runs.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretAddCommandLine } from '../../packages/core/src/secret-line.ts';
import { SECRET_ACCOUNT, storedSecretService } from '../../packages/core/src/secret-name.ts';
import { keeperFetch } from '../../packages/server/src/keeper/keeper-client.ts';
import { type CloudflareApi, cloudflareApi } from './cloudflare.ts';

/** The environment variable that stands in for the Keychain entry `name`. */
export const secretEnvName = (name: string): string =>
  `CW_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** Whether this run takes its secrets from the environment only (CI). */
export const secretsFromEnv = (): boolean => process.env.CW_SECRETS_FROM_ENV === '1';

function fromEnv(name: string): string | undefined {
  const v = process.env[secretEnvName(name)];
  return v !== undefined && v !== '' ? v : undefined;
}

export function keychainHas(name: string): boolean {
  if (fromEnv(name) !== undefined) return true;
  if (secretsFromEnv()) return false;
  const r = spawnSync(
    'security',
    ['find-generic-password', '-a', SECRET_ACCOUNT, '-s', storedSecretService(name)],
    { stdio: 'ignore', env: process.env },
  );
  return r.status === 0;
}

export function keychainRead(name: string): string {
  const v = fromEnv(name);
  if (v !== undefined) return v;
  if (secretsFromEnv()) throw new Error(`${secretEnvName(name)} is not set`);
  const r = spawnSync(
    'security',
    ['find-generic-password', '-a', SECRET_ACCOUNT, '-s', storedSecretService(name), '-w'],
    { encoding: 'utf8', env: process.env },
  );
  if (r.status !== 0) throw new Error(`Keychain has no entry ${name}`);
  return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
}

/** Store a NEW entry. Refuses to replace one, because an entry may guard snapshots. */
export function keychainCreate(name: string, value: string): void {
  if (secretsFromEnv()) {
    throw new Error(`${name} can only be made in the Mac's Keychain; run this deploy on the Mac`);
  }
  if (keychainHas(name)) throw new Error(`Keychain already has ${name}; not replacing it`);
  const line = secretAddCommandLine(name, Buffer.from(value, 'utf8').toString('base64'));
  const r = spawnSync('security', ['-i'], {
    input: `${line}\n`,
    encoding: 'utf8',
    env: process.env,
  });
  if (r.status !== 0 || !keychainHas(name))
    throw new Error(`could not store ${name} in the Keychain`);
}

/**
 * The Cloudflare API token, for a deploy script's API calls without the
 * keeper: CLOUDFLARE_API_TOKEN when set (CI), else the Keychain. `cf:plan`
 * reads it through `infra/cloudflare/credentials.ts`.
 * Held in memory only.
 */
export function cloudflareApiToken(): string {
  const env = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (env) return env;
  const entry = 'cloudflare-api-token';
  if (!keychainHas(entry)) throw new Error(`the Keychain has no ${entry}; nothing was changed`);
  return keychainRead(entry).trim();
}

/**
 * The deploy scripts' Cloudflare API: through the keeper once it holds the
 * token (`CW_KEEPER_URL`, `docs/process/keeper.md`), which prints the
 * approval link for a held call and reads nothing from the Keychain; with
 * the Keychain's token before that.
 */
export function cloudflareClient(requester: string): CloudflareApi {
  const keeper = process.env.CW_KEEPER_URL?.trim();
  if (!keeper) return cloudflareApi(cloudflareApiToken());
  return cloudflareApi(null, {
    base: `${keeper}/v1/cloudflare`,
    fetchImpl: keeperFetch(keeper, {
      requester,
      onHeld: (held) => {
        console.error(`[keeper] ${held.hold} waits for Bryan's passkey: ${held.summary}`);
        console.error(`[keeper] approve at ${held.approveUrl}`);
      },
    }),
  });
}

/** The keeper's macOS user (`docs/process/keeper.md`). */
const keeperUser = (): string => process.env.CW_KEEPER_USER?.trim() || 'cw-relay';

export interface KeeperStage {
  dir: string;
  /** Let the keeper's user read one file in `dir`. */
  share(path: string): void;
  done(): void;
}

/**
 * A folder for files the keeper's `fly` uploads. Through the keeper `fly`
 * runs as the keeper's user, which cannot open this user's temp folder. The
 * folder goes in `/tmp`, mode 700, with one ACL entry letting the keeper's
 * user list it, and each shared file is mode 600 with one entry letting it
 * read: no other user can open either. Without the keeper it is a plain
 * private temp folder.
 */
export function keeperStage(prefix: string): KeeperStage {
  if (!viaKeeper()) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    return { dir, share: () => {}, done: () => rmSync(dir, { recursive: true, force: true }) };
  }
  const user = keeperUser();
  const grant = (path: string, rights: string) => {
    const r = spawnSync('/bin/chmod', ['+a', `${user} allow ${rights}`, path], {
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(
        `could not let the keeper's user ${user} read ${path}: ${r.stderr.trim() || `chmod exited ${r.status}`}`,
      );
    }
  };
  // Checked before anything is made: chmod names an unknown user.
  const probe = spawnSync('/usr/bin/id', ['-u', user], { stdio: 'ignore' });
  if (probe.status !== 0) {
    throw new Error(`the keeper's user ${user} does not exist; set CW_KEEPER_USER`);
  }
  const dir = mkdtempSync(join('/tmp', prefix));
  const done = () => rmSync(dir, { recursive: true, force: true });
  try {
    chmodSync(dir, 0o700);
    grant(dir, 'list,search,readattr,readextattr,readsecurity');
  } catch (err) {
    done();
    throw err;
  }
  return {
    dir,
    share(path) {
      chmodSync(path, 0o600);
      grant(path, 'read,readattr,readextattr,readsecurity');
    },
    done,
  };
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

let flyToken: string | undefined;

/** The org token: FLY_API_TOKEN when the environment has it (CI), else the Keychain's. */
function orgToken(): string {
  const env = process.env.FLY_API_TOKEN?.trim();
  return env ? env : keychainRead('fly-org-token').trim();
}

const KEEPER_FLY_CLI = join(import.meta.dir, '../../packages/server/src/keeper/keeper-fly-cli.ts');

/**
 * Once the keeper holds the org token (`CW_KEEPER_URL` set,
 * `docs/process/keeper.md`), every `fly` call is asked of the keeper
 * instead: a routine one runs at once, a held one prints its approval link
 * and waits for Bryan's passkey. No token is read here.
 */
function keeperFlySync(args: string[], input: string | undefined): RunResult {
  const r = spawnSync(process.execPath, [KEEPER_FLY_CLI], {
    input: JSON.stringify({ args, ...(input !== undefined ? { input } : {}) }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return { status: 1, stdout: '', stderr: 'could not reach the keeper' };
  return JSON.parse(r.stdout) as RunResult;
}

const viaKeeper = (): boolean => Boolean(process.env.CW_KEEPER_URL?.trim());

/** Run `fly` with the org token in its environment. Output is returned, not shown. */
export function fly(args: string[], opts: { input?: string; quiet?: boolean } = {}): RunResult {
  if (viaKeeper()) return keeperFlySync(args, opts.input);
  flyToken ??= orgToken();
  const r = spawnSync('fly', args, {
    encoding: 'utf8',
    input: opts.input,
    env: { ...process.env, FLY_API_TOKEN: flyToken },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Like `fly`, but throws with the command's own error text when it fails. */
export function flyOk(args: string[], opts: { input?: string } = {}): string {
  const r = fly(args, opts);
  if (r.status !== 0) {
    throw new Error(
      `fly ${args.slice(0, 3).join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return r.stdout;
}

/** `fly <args> --json`, parsed. */
export function flyJson<T>(args: string[]): T {
  return JSON.parse(flyOk([...args, '--json'])) as T;
}

/** Run `fly` with its output going straight to this terminal (builds, deploys). */
export function flyLive(args: string[]): void {
  if (viaKeeper()) {
    // The keeper returns output when the command ends, not as it runs.
    const r = keeperFlySync(args, undefined);
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    if (r.status !== 0) throw new Error(`fly ${args.slice(0, 2).join(' ')} exited ${r.status}`);
    return;
  }
  flyToken ??= orgToken();
  const r = spawnSync('fly', args, {
    stdio: 'inherit',
    env: { ...process.env, FLY_API_TOKEN: flyToken },
  });
  if (r.status !== 0) throw new Error(`fly ${args.slice(0, 2).join(' ')} exited ${r.status}`);
}

/** A command run on the machine over `fly ssh console`, as root. */
export function onMachine(app: string, command: string): string {
  return flyOk([
    'ssh',
    'console',
    '--app',
    app,
    '--command',
    `sh -c '${command.replaceAll("'", `'\\''`)}'`,
  ]);
}
