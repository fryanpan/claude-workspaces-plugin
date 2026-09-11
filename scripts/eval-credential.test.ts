/**
 * The eval spends its own credential, and refuses rather than borrowing the
 * live meeting's.
 *
 * Driven through an injected keychain reader so the test asks WHICH service
 * names were consulted — the question that decides whether a sweep can
 * exhaust the key a meeting depends on. No real Keychain is touched and no
 * value here is a real credential.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KEYCHAIN_SERVICE,
  KEYCHAIN_SERVICE_LEGACY,
  LAUNCHD_JOB_ENV,
  PROD_SERVICE_LABEL,
} from '../packages/server/src/claude-key-source.ts';
import {
  EVAL_ACCESS_TOKEN_ENV,
  EVAL_CREDENTIAL_HELP,
  EVAL_KEYCHAIN_SERVICE,
  EVAL_KEY_ENV,
  resolveEvalCredentialFrom,
} from './eval-credential.ts';

/** A keychain holding whatever the test says, recording what was asked for.
 *  A missing item throws, exactly as `readKeychainPassword` does. */
function keychain(items: Record<string, string>) {
  const asked: string[] = [];
  const read = (service: string): string => {
    asked.push(service);
    const value = items[service];
    if (value === undefined) throw new Error(`no such item: ${service}`);
    return value;
  };
  return { read, asked };
}

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('the eval credential', () => {
  it('reads the eval item, not prod’s', () => {
    const k = keychain({ [EVAL_KEYCHAIN_SERVICE]: 'eval-value' });
    expect(resolveEvalCredentialFrom(undefined, k.read, {})).toEqual({
      kind: 'key',
      value: 'eval-value',
    });
    expect(k.asked).toEqual([EVAL_KEYCHAIN_SERVICE]);
  });

  it('refuses when only prod’s key exists, and never asks for it', () => {
    const k = keychain({
      [KEYCHAIN_SERVICE]: 'prod-value',
      [KEYCHAIN_SERVICE_LEGACY]: 'older-prod-value',
    });
    expect(resolveEvalCredentialFrom(undefined, k.read, {})).toBeNull();
    expect(k.asked).toEqual([EVAL_KEYCHAIN_SERVICE]);
  });

  it('refuses prod’s key even when run inside the prod service’s environment', () => {
    // The server reads prod's item under launchd's marker; the eval must not,
    // wherever it happens to be started from.
    const k = keychain({ [KEYCHAIN_SERVICE]: 'prod-value' });
    expect(
      resolveEvalCredentialFrom(undefined, k.read, { [LAUNCHD_JOB_ENV]: PROD_SERVICE_LABEL }),
    ).toBeNull();
    expect(k.asked).toEqual([EVAL_KEYCHAIN_SERVICE]);
  });

  it('ignores prod’s env override — that is the same credential by another route', () => {
    const k = keychain({});
    expect(
      resolveEvalCredentialFrom(undefined, k.read, { CW_SUMMARY_API_KEY: 'prod-value' }),
    ).toBeNull();
  });

  it('takes CI’s short-lived access token before the Keychain', () => {
    const k = keychain({ [EVAL_KEYCHAIN_SERVICE]: 'eval-value' });
    expect(
      resolveEvalCredentialFrom(undefined, k.read, { [EVAL_ACCESS_TOKEN_ENV]: 'run-token' }),
    ).toEqual({ kind: 'token', value: 'run-token' });
    expect(k.asked).toEqual([]);
  });

  it('lets an explicitly named key win over anything ambient', () => {
    const k = keychain({ [EVAL_KEYCHAIN_SERVICE]: 'eval-value' });
    expect(
      resolveEvalCredentialFrom('typed-value', k.read, { [EVAL_ACCESS_TOKEN_ENV]: 'run-token' }),
    ).toEqual({ kind: 'key', value: 'typed-value' });
  });

  it('takes an explicit null as "no credential", without consulting anything', () => {
    const k = keychain({ [EVAL_KEYCHAIN_SERVICE]: 'eval-value' });
    expect(resolveEvalCredentialFrom(null, k.read, {})).toBeNull();
    expect(k.asked).toEqual([]);
  });

  it('is what `bun run notes:eval` refuses with — the wiring, not just the helper', () => {
    // Drives the real entry point with an explicitly empty key, which is the
    // one no-credential path that spends nothing and consults no Keychain.
    // It proves the eval asks for the EVAL item: before this change the same
    // run named prod's, and would have gone on to spend it.
    const run = spawnSync('bun', ['scripts/notes-eval.ts', '--api-key', ''], {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf8',
      // The eval item is present via its env override, so the ONLY way this
      // run reaches the no-credential path is the flag being parsed and its
      // explicit empty value winning. Without that parse it would resolve the
      // override and go on to run. That makes the case decide something on a
      // machine that has the Keychain item and on one that does not.
      env: {
        ...process.env,
        [EVAL_KEY_ENV]: 'not-a-real-value',
        CW_SUMMARY_API_KEY: 'prod-shaped-value',
      },
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(EVAL_KEYCHAIN_SERVICE);
    expect(run.stderr).not.toContain(KEYCHAIN_SERVICE);
    expect(run.stdout).not.toContain('prod-shaped-value');
    expect(run.stderr).not.toContain('prod-shaped-value');
  });

  it('fails loudly by naming the item to add, and says prod’s is not a fallback', () => {
    expect(EVAL_CREDENTIAL_HELP).toContain(EVAL_KEYCHAIN_SERVICE);
    expect(EVAL_CREDENTIAL_HELP).not.toContain(KEYCHAIN_SERVICE);
    expect(EVAL_CREDENTIAL_HELP).toMatch(/never the one[\s\S]*live meetings use/);
  });

  it('offers no route the caller printing it does not have', () => {
    // One string, two entry points, and only `notes-eval.ts` reads argv for a
    // key — so help naming `--api-key` was false wherever `notes-eval-ideas.ts`
    // printed it. It is also the route that puts a credential in shell history
    // and the process list, so the env override is what gets recommended.
    expect(EVAL_CREDENTIAL_HELP).not.toContain('--api-key');
    expect(EVAL_CREDENTIAL_HELP).toContain(EVAL_KEY_ENV);
  });

  it('falls back to no ambient credential of any name', () => {
    // The fourth-bug check. Every plausible key-shaped variable is set and
    // the Keychain holds nothing the eval may read: the answer must still be
    // "there is no credential", never something picked up from the ambient
    // environment.
    const k = keychain({ [KEYCHAIN_SERVICE]: 'prod-value' });
    const ambient = {
      ANTHROPIC_API_KEY: 'ambient-value',
      CLAUDE_API_KEY: 'ambient-value',
      CW_SUMMARY_API_KEY: 'prod-value',
      CLAUDE_WORKSPACES_SUMMARY_API_KEY: 'prod-value',
      ANTHROPIC_AUTH_TOKEN: 'ambient-value',
    };
    expect(resolveEvalCredentialFrom(undefined, k.read, ambient)).toBeNull();
    expect(k.asked).toEqual([EVAL_KEYCHAIN_SERVICE]);
  });
});
