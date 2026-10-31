/**
 * The pieces of a lead's push that run without a server: the policy file,
 * the names it accepts, the credential source on each kind of host, and the
 * redaction every upstream error passes through.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type KeychainRead,
  PUSH_TOKEN_ENV,
  PUSH_TOKEN_SERVICE,
  pushCredentialFor,
} from '../src/git-push/credential.ts';
import { basicAuthHeader, redact } from '../src/git-push/git.ts';
import {
  GIT_PUSH_POLICY_FILE,
  isBranchName,
  isRepoName,
  parsePolicy,
  ruleFor,
} from '../src/git-push/policy.ts';
import { runPush } from '../src/git-push/run.ts';

const FAKE = 'fake-push-credential-for-tests-only';

describe('the push policy', () => {
  it('reads each board’s repos and approval flags, and nothing malformed', () => {
    const rules = parsePolicy(
      JSON.stringify({
        boards: {
          harbor: {
            repos: [{ repo: 'Harborlight/notes' }, { repo: 'Harborlight/app', approval: true }],
          },
        },
      }),
    );
    expect(rules?.get('harbor')).toEqual([
      { repo: 'Harborlight/notes', approval: false },
      { repo: 'Harborlight/app', approval: true },
    ]);
    for (const bad of [
      'not json',
      '{}',
      '{"boards":[]}',
      '{"boards":{"w":{"repos":[{"repo":"../etc"}]}}}',
      '{"boards":{"w":{"repos":[{"repo":"a/b","approval":"yes"}]}}}',
    ])
      expect(parsePolicy(bad)).toBeNull();
  });

  it('answers per board, case-insensitively, and allows nothing without a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-push-policy-'));
    expect(ruleFor(dir, 'harbor', 'Harborlight/notes')).toBeNull();
    writeFileSync(
      join(dir, GIT_PUSH_POLICY_FILE),
      JSON.stringify({ boards: { harbor: { repos: [{ repo: 'Harborlight/notes' }] } } }),
    );
    expect(ruleFor(dir, 'harbor', 'harborlight/NOTES')?.repo).toBe('Harborlight/notes');
    expect(ruleFor(dir, 'river', 'Harborlight/notes')).toBeNull();
    expect(ruleFor(dir, 'harbor', 'Riverbend/notes')).toBeNull();
  });

  it('accepts plain branch and repo names and refuses anything git or a shell could misread', () => {
    for (const ok of ['feature-a', 't-sz1/push-via-board', 'v1.2-fix'])
      expect(isBranchName(ok)).toBe(true);
    for (const bad of [
      '',
      '-f',
      '--force',
      'a..b',
      'a/',
      '/a',
      'a.lock',
      'HEAD',
      'refs/heads/x',
      'a b',
      'a~1',
      'a:b',
      '.hidden',
    ])
      expect(isBranchName(bad)).toBe(false);
    expect(isRepoName('Harborlight/notes')).toBe(true);
    for (const bad of ['notes', 'a/b/c', 'a/..', 'a/b.git', '-x/y', 'a/b c'])
      expect(isRepoName(bad)).toBe(false);
  });
});

describe('the push credential', () => {
  const keychain =
    (value: string | null, seen: string[][] = []): KeychainRead =>
    async (args) => {
      seen.push(args);
      return value ? { status: 0, stdout: `${value}\n` } : { status: 44, stdout: '' };
    };

  it('on a project server comes from the variable, which leaves the environment at boot', async () => {
    const env: Record<string, string | undefined> = {
      FLY_APP_NAME: 'cw-riverbend',
      [PUSH_TOKEN_ENV]: FAKE,
    };
    const seen: string[][] = [];
    const cred = pushCredentialFor(env, keychain('from-keychain', seen));
    expect(env[PUSH_TOKEN_ENV]).toBeUndefined();
    expect(await cred()).toBe(FAKE);
    expect(seen).toEqual([]);
  });

  it('on the Mac comes from the Keychain, and a variable is removed, not used', async () => {
    const env: Record<string, string | undefined> = { USER: 'alice', [PUSH_TOKEN_ENV]: 'from-env' };
    const seen: string[][] = [];
    const cred = pushCredentialFor(env, keychain(FAKE, seen));
    expect(env[PUSH_TOKEN_ENV]).toBeUndefined();
    expect(await cred()).toBe(FAKE);
    expect(seen[0]).toEqual([
      'find-generic-password',
      '-a',
      'alice',
      '-s',
      PUSH_TOKEN_SERVICE,
      '-w',
    ]);
    // Read once, then held in memory.
    await cred();
    expect(seen).toHaveLength(1);
  });

  it('is null when the host has none', async () => {
    expect(await pushCredentialFor({ FLY_APP_NAME: 'cw-riverbend' }, keychain(FAKE))()).toBeNull();
    expect(await pushCredentialFor({}, keychain(null))()).toBeNull();
  });
});

describe('redaction', () => {
  it('removes the credential and its header form from text', () => {
    const header = basicAuthHeader(FAKE);
    const text = `fatal: https://x-access-token:${FAKE}@github.com refused; ${header}`;
    const out = redact(text, FAKE);
    expect(out).not.toContain(FAKE);
    expect(out).not.toContain(header.split(' ').pop() ?? '');
    expect(out).toContain('[credential]');
  });
});

describe('runPush', () => {
  const input = (root: string) => ({
    id: 'a'.repeat(24),
    repo: 'Harborlight/notes',
    branch: 'feature-x',
    bundle: join(root, 'missing.bundle'),
  });

  it('refuses with no credential, runs no git, and leaves no work repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-push-run-'));
    const calls: string[][] = [];
    const r = await runPush(
      {
        root,
        credential: async () => null,
        remoteUrlFor: () => 'https://example.invalid/x.git',
        runGit: async (c) => {
          calls.push(c.args);
          return { code: 0, stdout: '', stderr: '' };
        },
      },
      input(root),
      true,
    );
    expect(r).toMatchObject({ ok: false, status: 503, error: 'no-credential' });
    expect(calls).toEqual([]);
    expect(existsSync(join(root, 'work', `${'a'.repeat(24)}.git`))).toBe(false);
  });

  it('removes the work repo when git throws mid-run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-push-run-'));
    let n = 0;
    const run = runPush(
      {
        root,
        credential: async () => FAKE,
        remoteUrlFor: () => 'https://example.invalid/x.git',
        runGit: async () => {
          n += 1;
          if (n > 2) throw new Error('spawn failed');
          return { code: 0, stdout: '', stderr: '' };
        },
      },
      input(root),
      true,
    );
    await expect(run).rejects.toThrow('spawn failed');
    expect(existsSync(join(root, 'work', `${'a'.repeat(24)}.git`))).toBe(false);
    expect(existsSync(join(root, 'auth')) ? readdirSync(join(root, 'auth')) : []).toEqual([]);
  });
});
