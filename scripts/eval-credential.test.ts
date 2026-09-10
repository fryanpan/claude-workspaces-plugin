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
import { KEYCHAIN_SERVICE, KEYCHAIN_SERVICE_LEGACY } from '../packages/server/src/summarize.ts';
import {
  EVAL_ACCESS_TOKEN_ENV,
  EVAL_CREDENTIAL_HELP,
  EVAL_KEYCHAIN_SERVICE,
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
      env: { ...process.env, CW_SUMMARY_API_KEY: 'prod-shaped-value' },
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
});
