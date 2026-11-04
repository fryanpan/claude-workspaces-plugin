/**
 * Where the board server finds the GitHub credential it pushes with, on each
 * kind of host. A lead never holds it: the lead sends a bundle, and the
 * server pushes.
 *
 * - **A project server** (Fly, or anything `isProjectServer` names): one
 *   write deploy key per repo, from the Fly secret `CW_GITHUB_PUSH_KEYS`. The
 *   keeper makes each key pair during project setup, registers the public
 *   half on its one repo, and sets this secret with the private halves
 *   (`keeper/keeper-push-keys.ts`). A deploy key reaches one repo, so a
 *   project server can push to the repos it was given keys for and nothing
 *   else Bryan's account can reach. It holds no classic token: a
 *   `CW_GITHUB_PUSH_TOKEN` there is removed from the environment and never
 *   used. The entrypoint's `drop_secrets` does not name the keys secret, so
 *   it reaches the `cw` server; the lead's `only_env` list does not name it
 *   either, so the `lead` user never has it. It is taken out of `process.env`
 *   at boot so no child the server starts inherits it. `ps eww` still prints
 *   the server's environment as it was at exec, but only to root or the same
 *   uid, and the lead is a different uid. There is no Keychain there.
 * - **The Mac**: the Keychain item `cw-github-push-token`, read on the first
 *   push and kept in memory. The walled lead's Seatbelt profile denies the
 *   Keychain's services. The variable is ignored there and removed from
 *   `process.env`, but that removal does not hide a value the server was
 *   started with: a same-user lead can read it with `ps eww`. So on the Mac
 *   the credential comes from the Keychain only, never the variable.
 *
 * Nothing here returns the value inside a message. Callers get the value or
 * null, and say "no credential" in their own words.
 */
import type { EnvLike } from '@claude-workspaces/core/env-names';
import { isProjectServer } from '../project-profile.ts';

export const PUSH_TOKEN_ENV = 'CW_GITHUB_PUSH_TOKEN';
export const PUSH_TOKEN_SERVICE = 'cw-github-push-token';
/** The Fly secret holding a project server's deploy keys (`encodePushKeys`). */
export const PUSH_KEYS_ENV = 'CW_GITHUB_PUSH_KEYS';

/** How the server proves itself to GitHub for one repo. */
export type PushAuth =
  | { kind: 'token'; token: string }
  /** An OpenSSH private key, registered on this one repo as a write deploy key. */
  | { kind: 'ssh-key'; key: string };

/** The credential for `repo`, or null when this host has none for it. */
export type PushCredential = (repo: string) => Promise<PushAuth | null>;

/** `security` with these arguments: its exit status and stdout. Injected, so
 *  no test touches a real Keychain. */
export type KeychainRead = (args: string[]) => Promise<{ status: number; stdout: string }>;

const PRIVATE_KEY =
  /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END OPENSSH PRIVATE KEY-----\n?$/;

/**
 * The secret's value for these keys: BASE64 of `{"keys":{"owner/name":"<key>"}}`,
 * so it is one line in `fly secrets import`.
 */
export function encodePushKeys(keys: ReadonlyMap<string, string>): string {
  return Buffer.from(JSON.stringify({ keys: Object.fromEntries(keys) })).toString('base64');
}

/**
 * The keys in a secret's value, by lower-cased repo. Null when it does not
 * decode, or any entry is not an OpenSSH private key.
 */
export function parsePushKeys(value: string): Map<string, string> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(value.trim(), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const keys = (raw as { keys?: unknown } | null)?.keys;
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) return null;
  const out = new Map<string, string>();
  for (const [repo, key] of Object.entries(keys)) {
    if (typeof key !== 'string' || !PRIVATE_KEY.test(key)) return null;
    out.set(repo.toLowerCase(), key.endsWith('\n') ? key : `${key}\n`);
  }
  return out;
}

/** Take the variable out of `env` and hand back its value. */
export function takePushTokenFromEnv(env: EnvLike): string | null {
  const value = env[PUSH_TOKEN_ENV]?.trim() || null;
  Reflect.deleteProperty(env, PUSH_TOKEN_ENV);
  return value;
}

/**
 * The credential source for this host. Call once, at boot: it removes both
 * variables from `env` as it reads them.
 */
export function pushCredentialFor(
  env: EnvLike,
  keychain: KeychainRead = securityRead,
): PushCredential {
  // Removed on every host and used on none: a project server pushes with
  // deploy keys, and the Mac reads the Keychain.
  takePushTokenFromEnv(env);
  const keysValue = env[PUSH_KEYS_ENV]?.trim() ?? '';
  Reflect.deleteProperty(env, PUSH_KEYS_ENV);
  if (isProjectServer(env)) {
    const keys = keysValue ? parsePushKeys(keysValue) : null;
    return async (repo) => {
      const key = keys?.get(repo.toLowerCase());
      return key ? { kind: 'ssh-key', key } : null;
    };
  }
  let cached: string | null = null;
  return async () => {
    if (cached) return { kind: 'token', token: cached };
    const user = env.USER?.trim();
    const lookups = [
      ...(user ? [['find-generic-password', '-a', user, '-s', PUSH_TOKEN_SERVICE, '-w']] : []),
      ['find-generic-password', '-s', PUSH_TOKEN_SERVICE, '-w'],
    ];
    for (const args of lookups) {
      const r = await keychain(args);
      const value = r.status === 0 ? r.stdout.trim() : '';
      if (value) {
        cached = value;
        return { kind: 'token', token: value };
      }
    }
    return null;
  };
}

/** The real `security` call, bounded so a consent dialog cannot hold a push. */
async function securityRead(args: string[]): Promise<{ status: number; stdout: string }> {
  const proc = Bun.spawn(['/usr/bin/security', ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const timer = setTimeout(() => proc.kill(), 10_000);
  try {
    const stdout = await new Response(proc.stdout).text();
    return { status: await proc.exited, stdout };
  } finally {
    clearTimeout(timer);
  }
}
