/**
 * The Mac side of the deploy scripts: the Keychain, and `fly` run with the
 * org token in its environment.
 *
 * Every value read from the Keychain goes into a child's environment or
 * stdin and nowhere else: never an argument (`ps` shows arguments to every
 * user), never a log line, never a file. Values are stored base64-encoded on
 * stdin, the same way the server's own secret store writes them
 * (`packages/server/src/secret-store.ts`).
 */
import { spawnSync } from 'node:child_process';
import { secretAddCommandLine } from '../../packages/core/src/secret-line.ts';
import { SECRET_ACCOUNT, storedSecretService } from '../../packages/core/src/secret-name.ts';

export function keychainHas(name: string): boolean {
  const r = spawnSync(
    'security',
    ['find-generic-password', '-a', SECRET_ACCOUNT, '-s', storedSecretService(name)],
    { stdio: 'ignore' },
  );
  return r.status === 0;
}

export function keychainRead(name: string): string {
  const r = spawnSync(
    'security',
    ['find-generic-password', '-a', SECRET_ACCOUNT, '-s', storedSecretService(name), '-w'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`Keychain has no entry ${name}`);
  return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
}

/** Store a NEW entry. Refuses to replace one, because an entry may guard snapshots. */
export function keychainCreate(name: string, value: string): void {
  if (keychainHas(name)) throw new Error(`Keychain already has ${name}; not replacing it`);
  const line = secretAddCommandLine(name, Buffer.from(value, 'utf8').toString('base64'));
  const r = spawnSync('security', ['-i'], { input: `${line}\n`, encoding: 'utf8' });
  if (r.status !== 0 || !keychainHas(name))
    throw new Error(`could not store ${name} in the Keychain`);
}

/**
 * The Cloudflare API token, for `router:deploy` and a named tunnel. Every
 * read of it is this one function, so moving where it is kept changes one
 * place. Held in memory only.
 */
export function cloudflareApiToken(): string {
  const entry = 'cloudflare-api-token';
  if (!keychainHas(entry)) throw new Error(`the Keychain has no ${entry}; nothing was changed`);
  return keychainRead(entry).trim();
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

let flyToken: string | undefined;

/** Run `fly` with the org token in its environment. Output is returned, not shown. */
export function fly(args: string[], opts: { input?: string; quiet?: boolean } = {}): RunResult {
  flyToken ??= keychainRead('fly-org-token').trim();
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
  flyToken ??= keychainRead('fly-org-token').trim();
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
