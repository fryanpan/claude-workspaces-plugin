/**
 * The Mac side of the deploy scripts: the Keychain, and `fly` run with a
 * token in its environment (`flyTokenFor`).
 *
 * Off the Mac every Keychain entry can be handed in instead as the
 * environment variable `secretEnvName(entry)` (`fly-org-slug` ->
 * CW_SECRET_FLY_ORG_SLUG), plain rather than base64, and the Fly token as
 * FLY_API_TOKEN. With CW_SECRETS_FROM_ENV=1 the Keychain is never asked at
 * all. An entry made in such a run (a project's backup identity and bucket
 * credentials, in `fly-provision.yml`) goes to the run's handoff sink
 * (CW_HANDOFF_OUT, `infra/handoff/`), sealed to the Mac, which stores it in
 * its Keychain on the next `handoff:pull`; without a sink it is refused.
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
import { asCw, machineShell } from '../../packages/server/src/keeper/keeper-move-steps.ts';
import { type HandoffSink, macSinkFromEnv } from '../handoff/items.ts';
import { handoffDir, readAppToken } from '../handoff/mac-store.ts';

/** The environment variable that stands in for the Keychain entry `name`. */
export const secretEnvName = (name: string): string =>
  `CW_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** Whether this run takes its secrets from the environment only (CI). */
export const secretsFromEnv = (): boolean => process.env.CW_SECRETS_FROM_ENV === '1';

/** Entries this CI run made, sealed to the Mac at its end and readable until then. */
const madeHere = new Map<string, string>();
let sink: HandoffSink | null = null;

/**
 * The run's handoff sink (CW_HANDOFF_OUT), or null when it has none. One per
 * file, so everything one run makes lands in the same sink.
 */
export function handoffSink(): HandoffSink | null {
  const want = macSinkFromEnv(process.env);
  if (want === null) return null;
  if (sink?.outPath !== want.outPath) sink = want;
  return sink;
}

function fromEnv(name: string): string | undefined {
  const made = madeHere.get(name);
  if (made !== undefined) return made;
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
    const out = handoffSink();
    if (!out) {
      throw new Error(
        `${name} is made only in a run that hands it to the Mac (CW_HANDOFF_OUT, fly-provision.yml)`,
      );
    }
    if (keychainHas(name)) throw new Error(`${name} already exists; not replacing it`);
    out.add({ kind: 'keychain', name, value });
    madeHere.set(name, value);
    return;
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

/** A private temp folder for files `fly` uploads (`fly ssh sftp`). */
export interface PrivateStage {
  dir: string;
  /** Make one file in `dir` readable by this user alone. */
  share(path: string): void;
  done(): void;
}

/** A folder only this user can open, removed by `done`. */
export function privateStage(prefix: string): PrivateStage {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  return {
    dir,
    share: (path) => chmodSync(path, 0o600),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** The app a `fly` command names with `--app`/`-a`, if any. */
export function appOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if ((a === '--app' || a === '-a') && i + 1 < args.length) return args[i + 1];
    if (a.startsWith('--app=')) return a.slice('--app='.length);
  }
  return undefined;
}

export interface FlyTokenSource {
  env: Record<string, string | undefined>;
  /** The Mac's token for one app (`infra/handoff/mac-store.ts`), or null. */
  appToken: (app: string) => string | null;
  /** `bun run handoff:pull`, once, when the Mac has no token for the app. */
  pull: () => void;
}

/**
 * The token a `fly` command runs with. FLY_API_TOKEN when set: in CI that is
 * the org token in `fly-org`, or one app's token in `fly-<project>`
 * (`ci-tokens.ts`). On the Mac, which holds no org token since the keeper
 * retired, the token CI cut for the one app the command names, pulled from
 * CI's handoff if it is missing or near its end. A command that names no
 * app needs the org token and runs only in CI.
 */
export function flyTokenFor(args: readonly string[], src: FlyTokenSource): string {
  const env = src.env.FLY_API_TOKEN?.trim();
  if (env) return env;
  const app = appOf(args);
  if (!app || !app.startsWith('cw-')) {
    throw new Error(
      `fly ${args.slice(0, 2).join(' ')} needs the Fly org token, which only CI holds: run it in .github/workflows/fly-provision.yml (docs/process/project-machine.md)`,
    );
  }
  const have = src.appToken(app);
  if (have) return have;
  src.pull();
  const pulled = src.appToken(app);
  if (pulled) return pulled;
  throw new Error(
    `this Mac has no Fly token for ${app}: dispatch .github/workflows/fly-ci-tokens.yml, then bun run handoff:pull`,
  );
}

let pulled = false;
function realTokenSource(): FlyTokenSource {
  return {
    env: process.env,
    appToken: (app) => readAppToken(handoffDir(), app, Date.now()),
    pull: () => {
      if (pulled) return;
      pulled = true;
      spawnSync(process.execPath, [join(import.meta.dir, '..', 'handoff', 'pull.ts')], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    },
  };
}

const tokenEnv = (args: string[]) => ({
  ...process.env,
  FLY_API_TOKEN: flyTokenFor(args, realTokenSource()),
});

/** Run `fly` with its token in its environment. Output is returned, not shown. */
export function fly(args: string[], opts: { input?: string; quiet?: boolean } = {}): RunResult {
  const r = spawnSync('fly', args, {
    encoding: 'utf8',
    input: opts.input,
    env: tokenEnv(args),
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
  const r = spawnSync('fly', args, { stdio: 'inherit', env: tokenEnv(args) });
  if (r.status !== 0) throw new Error(`fly ${args.slice(0, 2).join(' ')} exited ${r.status}`);
}

/** A command run on the machine over `fly ssh console`, as root. */
export function onMachine(app: string, command: string): string {
  return flyOk(['ssh', 'console', '--app', app, '--command', machineShell(command)]);
}

export { asCw };
