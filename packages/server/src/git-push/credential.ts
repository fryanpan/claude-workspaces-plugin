/**
 * Where the board server finds the GitHub credential it pushes with, on each
 * kind of host. A lead never holds it: the lead sends a bundle, and the
 * server pushes.
 *
 * - **A project server** (Fly, or anything `isProjectServer` names): the Fly
 *   secret `CW_GITHUB_PUSH_TOKEN`. The entrypoint's `drop_secrets` does not
 *   name it, so it reaches the `cw` server; the lead's `only_env` list does
 *   not name it either, so the `lead` user never has it. It is taken out of
 *   this process's environment at boot, so no child the server starts
 *   inherits it. There is no Keychain there.
 * - **The Mac**: the Keychain item `cw-github-push-token`, read on the first
 *   push and kept in memory. The walled lead's Seatbelt profile denies the
 *   Keychain's services. The variable is ignored there and removed, because
 *   a same-user process can read another's starting environment (`ps eww`).
 *
 * Nothing here returns the value inside a message. Callers get the value or
 * null, and say "no credential" in their own words.
 */
import type { EnvLike } from '@claude-workspaces/core/env-names';
import { isProjectServer } from '../project-profile.ts';

export const PUSH_TOKEN_ENV = 'CW_GITHUB_PUSH_TOKEN';
export const PUSH_TOKEN_SERVICE = 'cw-github-push-token';

/** The credential, or null when this host has none. */
export type PushCredential = () => Promise<string | null>;

/** `security` with these arguments: its exit status and stdout. Injected, so
 *  no test touches a real Keychain. */
export type KeychainRead = (args: string[]) => Promise<{ status: number; stdout: string }>;

/** Take the variable out of `env` and hand back its value (project servers only). */
export function takePushTokenFromEnv(env: EnvLike): string | null {
  const value = env[PUSH_TOKEN_ENV]?.trim() || null;
  Reflect.deleteProperty(env, PUSH_TOKEN_ENV);
  return value;
}

/**
 * The credential source for this host. Call once, at boot: on a project
 * server it removes the variable from `env` as it reads it.
 */
export function pushCredentialFor(
  env: EnvLike,
  keychain: KeychainRead = securityRead,
): PushCredential {
  const fromEnv = takePushTokenFromEnv(env);
  if (isProjectServer(env)) return async () => fromEnv;
  let cached: string | null = null;
  return async () => {
    if (cached) return cached;
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
        return value;
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
