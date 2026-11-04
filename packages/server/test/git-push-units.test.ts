/**
 * The pieces of a lead's push that run without a server: the policy file,
 * the names it accepts, the credential source on each kind of host, and the
 * redaction every upstream error passes through.
 */
import { describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type KeychainRead,
  PUSH_KEYS_ENV,
  PUSH_TOKEN_ENV,
  PUSH_TOKEN_SERVICE,
  encodePushKeys,
  parsePushKeys,
  pushCredentialFor,
} from '../src/git-push/credential.ts';
import {
  PINNED_KNOWN_HOSTS,
  ScratchRepo,
  basicAuthHeader,
  realGit,
  redact,
} from '../src/git-push/git.ts';
import {
  GIT_PUSH_POLICY_FILE,
  isBranchName,
  isRepoName,
  parsePolicy,
  ruleFor,
} from '../src/git-push/policy.ts';
import { runPush } from '../src/git-push/run.ts';

const FAKE = 'fake-push-credential-for-tests-only';
/** Not a key: the shape of one, so the parser and the redaction have something to read. */
const KEY_A = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'b3BlbnNzaC1rZXktdjEAAAAA'.repeat(3)}\nZmFrZS1rZXktZm9yLXRlc3RzLW9ubHk=\n-----END OPENSSH PRIVATE KEY-----\n`;

describe('the push policy', () => {
  it('reads each board’s repos and approval flags, approval only when asked for, and nothing malformed', () => {
    const rules = parsePolicy(
      JSON.stringify({
        boards: {
          harbor: {
            repos: [
              { repo: 'Harborlight/notes' },
              { repo: 'Harborlight/app', approval: true },
              { repo: 'Harborlight/docs', approval: false },
            ],
          },
        },
      }),
    );
    expect(rules?.get('harbor')).toEqual([
      // Approval is opt-in: only an explicit true holds every push.
      { repo: 'Harborlight/notes', approval: false },
      { repo: 'Harborlight/app', approval: true },
      { repo: 'Harborlight/docs', approval: false },
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

  it('on a project server is one deploy key per repo, and the variables leave the environment at boot', async () => {
    const env: Record<string, string | undefined> = {
      FLY_APP_NAME: 'cw-riverbend',
      [PUSH_KEYS_ENV]: encodePushKeys(new Map([['Riverbend/notes', KEY_A]])),
    };
    const seen: string[][] = [];
    const cred = pushCredentialFor(env, keychain('from-keychain', seen));
    expect(env[PUSH_KEYS_ENV]).toBeUndefined();
    expect(await cred('riverbend/NOTES')).toEqual({ kind: 'ssh-key', key: KEY_A });
    // A deploy key reaches one repo, so a repo with no key has no credential.
    expect(await cred('Riverbend/other')).toBeNull();
    expect(seen).toEqual([]);
  });

  it('on a project server never pushes with a classic token, even one it was given', async () => {
    const env: Record<string, string | undefined> = {
      FLY_APP_NAME: 'cw-riverbend',
      [PUSH_TOKEN_ENV]: FAKE,
    };
    const cred = pushCredentialFor(env, keychain(FAKE));
    expect(env[PUSH_TOKEN_ENV]).toBeUndefined();
    expect(await cred('Riverbend/notes')).toBeNull();
  });

  it('on the Mac comes from the Keychain, and a variable is removed, not used', async () => {
    const env: Record<string, string | undefined> = { USER: 'alice', [PUSH_TOKEN_ENV]: 'from-env' };
    const seen: string[][] = [];
    const cred = pushCredentialFor(env, keychain(FAKE, seen));
    expect(env[PUSH_TOKEN_ENV]).toBeUndefined();
    expect(await cred('Harborlight/notes')).toEqual({ kind: 'token', token: FAKE });
    expect(seen[0]).toEqual([
      'find-generic-password',
      '-a',
      'alice',
      '-s',
      PUSH_TOKEN_SERVICE,
      '-w',
    ]);
    // Read once, then held in memory.
    await cred('Harborlight/notes');
    expect(seen).toHaveLength(1);
  });

  it('is null when the host has none, or its keys do not parse', async () => {
    expect(
      await pushCredentialFor({ FLY_APP_NAME: 'cw-riverbend' }, keychain(FAKE))('a/b'),
    ).toBeNull();
    expect(await pushCredentialFor({}, keychain(null))('a/b')).toBeNull();
    const bad = Buffer.from(JSON.stringify({ keys: { 'a/b': 'not a key' } })).toString('base64');
    expect(parsePushKeys(bad)).toBeNull();
    expect(parsePushKeys('not base64 json')).toBeNull();
    expect(
      await pushCredentialFor({ FLY_APP_NAME: 'cw-riverbend', [PUSH_KEYS_ENV]: bad })('a/b'),
    ).toBeNull();
  });
});

describe('a push with a deploy key', () => {
  it('reaches upstream over ssh with only the key and the pinned host keys, in files that are gone after', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-push-ssh-'));
    const auth = join(root, 'auth');
    const seen: { config: string; key: string; keyMode: number; env: Record<string, string> }[] =
      [];
    const repo = new ScratchRepo(
      join(root, 'm.git'),
      async (c) => {
        const file = c.env.GIT_CONFIG_GLOBAL ?? '';
        const config = readFileSync(file, 'utf8');
        const keyPath = /-i '([^']+)'/.exec(config)?.[1] ?? '';
        seen.push({
          config,
          key: readFileSync(keyPath, 'utf8'),
          keyMode: statSync(keyPath).mode & 0o777,
          env: c.env,
        });
        return { code: 0, stdout: 'ref: refs/heads/main\tHEAD\n', stderr: '' };
      },
      auth,
    );
    const up = {
      url: 'ssh://git@github.com/Riverbend/notes.git',
      auth: { kind: 'ssh-key' as const, key: KEY_A },
    };
    await repo.upstreamState(up, 'feature-x');
    const [call] = seen;
    expect(call?.key).toBe(KEY_A);
    expect(call?.keyMode).toBe(0o600);
    for (const opt of [
      '-F /dev/null',
      '-o IdentitiesOnly=yes',
      '-o IdentityAgent=none',
      '-o StrictHostKeyChecking=yes',
      `-o UserKnownHostsFile='${PINNED_KNOWN_HOSTS}'`,
    ])
      expect(call?.config).toContain(opt);
    // The key is in neither git's environment nor the config text.
    const keyLine = KEY_A.split('\n')[1] ?? '';
    expect(JSON.stringify(call?.env)).not.toContain(keyLine);
    expect(call?.config).not.toContain(keyLine);
    expect(readdirSync(auth)).toEqual([]);
  });

  it('is the ssh real git runs, with the key file and the pinned host keys', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-push-ssh-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'ssh.log');
    // A stand-in ssh: it records its arguments and the key it was handed, and fails.
    writeFileSync(
      join(bin, 'ssh'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nwhile [ $# -gt 0 ]; do [ "$1" = -i ] && cat "$2" >> '${log}'; shift; done\nexit 255\n`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const repo = new ScratchRepo(join(root, 'm.git'), realGit, join(root, 'auth'));
      await repo.ensure();
      const up = {
        url: 'ssh://git@github.com/Riverbend/notes.git',
        auth: { kind: 'ssh-key' as const, key: KEY_A },
      };
      expect('error' in (await repo.upstreamState(up, 'feature-x'))).toBe(true);
    } finally {
      process.env.PATH = path;
    }
    const seen = readFileSync(log, 'utf8');
    expect(seen).toContain('IdentitiesOnly=yes');
    expect(seen).toContain(`UserKnownHostsFile=${PINNED_KNOWN_HOSTS}`);
    expect(seen).toContain('git@github.com');
    expect(seen).toContain(KEY_A.trim());
    expect(readdirSync(join(root, 'auth'))).toEqual([]);
  });

  it('is refused on an https remote, and a token on an ssh one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-push-ssh-'));
    const calls: string[][] = [];
    const repo = new ScratchRepo(
      join(root, 'm.git'),
      async (c) => {
        calls.push(c.args);
        return { code: 0, stdout: '', stderr: '' };
      },
      join(root, 'auth'),
    );
    const key = { kind: 'ssh-key' as const, key: KEY_A };
    const token = { kind: 'token' as const, token: FAKE };
    expect(
      (await repo.git(['ls-remote'], { url: 'https://github.com/a/b.git', auth: key })).code,
    ).toBe(128);
    expect(
      (await repo.git(['ls-remote'], { url: 'ssh://git@github.com/a/b.git', auth: token })).code,
    ).toBe(128);
    expect(calls).toEqual([]);
  });

  it('takes the key out of an upstream error', () => {
    const line = KEY_A.split('\n')[1] ?? '';
    expect(redact(`fatal: ${line}`, { kind: 'ssh-key', key: KEY_A })).toBe('fatal: [credential]');
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
    holdGithub: true,
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
        credential: async () => ({ kind: 'token' as const, token: FAKE }),
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
