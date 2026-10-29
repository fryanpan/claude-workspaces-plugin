/**
 * The launcher hands a walled lead its Claude Code token. Driven through
 * `main` with a fake keychain reader and a fake spawn: nothing here reads
 * the real keychain or starts a sandboxed `claude`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Spawn,
  TOKEN_ENV,
  TOKEN_SERVICE,
  decodeToken,
  resolveAccount,
  tokenEnv,
  turnCheck,
  turnRow,
} from './lead-sandbox-token.ts';
import { type LaunchDeps, main } from './lead-sandbox.ts';

const TOKEN = 'sk-ant-oat01-test-harborlight-0000';
const OTHER = 'sk-ant-oat01-test-riverbend-1111';
const b64 = (t: string) => `${Buffer.from(t).toString('base64')}\n`;
const STORED = b64(TOKEN);
/** The un-labelled item only. */
const PLAIN = { [TOKEN_SERVICE]: STORED };
/** One item per labelled account. */
const BOTH = {
  [`${TOKEN_SERVICE}.harborlight`]: b64(TOKEN),
  [`${TOKEN_SERVICE}.riverbend`]: b64(OTHER),
};

const root = mkdtempSync(join(tmpdir(), 'lead-sandbox-token-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let configs = 0;
function configFile(
  allowKeychain: boolean,
  accounts: {
    claudeAccounts?: string[];
    defaultClaudeAccount?: string;
    claudeAccount?: string;
  } = {},
): string {
  const project = join(root, 'dev', 'harborlight');
  mkdirSync(project, { recursive: true });
  const file = join(root, `config-${configs++}.json`);
  const { claudeAccount, ...top } = accounts;
  writeFileSync(
    file,
    JSON.stringify({
      ...top,
      leads: [{ name: 'harborlight-lead', projects: [project], allowKeychain, claudeAccount }],
    }),
  );
  return file;
}

interface Run {
  code: number;
  lines: string[];
  spawned: { file: string; args: string[]; env: Record<string, string | undefined> }[];
  reads: string[];
}

function run(argv: string[], items: Record<string, string>): Run {
  const out: Run = { code: 0, lines: [], spawned: [], reads: [] };
  const deps: LaunchDeps = {
    platform: 'darwin',
    say: (line) => out.lines.push(line),
    readToken: (service) => {
      out.reads.push(service);
      return items[service] ?? null;
    },
    spawn: (file, args, opts) => {
      out.spawned.push({ file, args, env: opts.env });
      return 0;
    },
  };
  out.code = main(argv, deps);
  return out;
}

const launchWith = (config: string, ...extra: string[]) => [
  '--config',
  config,
  '--profiles',
  join(root, 'profiles'),
  '--lead',
  'harborlight-lead',
  ...extra,
  '--',
  'claude',
];
const launch = (allowKeychain: boolean) => launchWith(configFile(allowKeychain));
const dryRun = (config: string, ...extra: string[]) => [
  '--config',
  config,
  '--profiles',
  join(root, 'profiles'),
  ...extra,
];

let written: string[] = [];
beforeEach(() => {
  written = [];
  const capture = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

describe('launching a walled lead', () => {
  it('hands the decoded token to the child as CLAUDE_CODE_OAUTH_TOKEN', () => {
    const r = run(launch(false), PLAIN);
    expect(r.code).toBe(0);
    expect(r.spawned).toHaveLength(1);
    expect(r.spawned[0]?.env[TOKEN_ENV]).toBe(TOKEN);
    expect(r.spawned[0]?.args).not.toContain(TOKEN);
  });

  it('refuses the launch, naming the item and `claude setup-token`, when the item is missing', () => {
    const r = run(launch(false), {});
    expect(r.code).toBe(2);
    expect(r.spawned).toHaveLength(0);
    const said = r.lines.join('\n');
    expect(said).toContain(TOKEN_SERVICE);
    expect(said).toContain('claude setup-token');
  });

  it('refuses a stored value that is not BASE64', () => {
    const r = run(launch(false), { [TOKEN_SERVICE]: 'not base64!' });
    expect(r.code).toBe(2);
    expect(r.spawned).toHaveLength(0);
  });

  it('launches an allowKeychain lead without a token', () => {
    const r = run(launch(true), {});
    expect(r.code).toBe(0);
    expect(r.spawned).toHaveLength(1);
    expect(r.spawned[0]?.env[TOKEN_ENV]).toBeUndefined();
  });

  it('never writes the value to stdout, stderr or the dry run', () => {
    const runs = [run(launch(false), PLAIN), run(dryRun(configFile(false)), PLAIN)];
    for (const r of runs) expect(r.lines.join('\n')).not.toContain(TOKEN);
    expect(written.join('')).not.toContain(TOKEN);
    expect(written.join('')).not.toContain(STORED.trim());
  });

  it('does not read the keychain for a dry run', () => {
    const r = run(dryRun(configFile(false)), PLAIN);
    expect(r.code).toBe(0);
    expect(r.reads).toEqual([]);
  });
});

describe('choosing a Claude account', () => {
  const two = { claudeAccounts: ['harborlight', 'riverbend'] };

  it("signs a lead in with its own account's item", () => {
    const r = run(launchWith(configFile(false, { ...two, claudeAccount: 'riverbend' })), BOTH);
    expect(r.code).toBe(0);
    expect(r.reads).toEqual([`${TOKEN_SERVICE}.riverbend`]);
    expect(r.spawned[0]?.env[TOKEN_ENV]).toBe(OTHER);
  });

  it('falls back to defaultClaudeAccount, and --claude-account overrides both', () => {
    const config = configFile(false, { ...two, defaultClaudeAccount: 'harborlight' });
    expect(run(launchWith(config), BOTH).spawned[0]?.env[TOKEN_ENV]).toBe(TOKEN);
    const moved = run(launchWith(config, '--claude-account', 'riverbend'), BOTH);
    expect(moved.spawned[0]?.env[TOKEN_ENV]).toBe(OTHER);
  });

  it('refuses an account that is not listed, naming the item', () => {
    const r = run(launchWith(configFile(false, two), '--claude-account', 'saltmarsh'), BOTH);
    expect(r.code).toBe(2);
    expect(r.spawned).toHaveLength(0);
    expect(r.lines.join('\n')).toContain(`${TOKEN_SERVICE}.saltmarsh`);
  });

  it('refuses a listed account whose item is missing, even for an allowKeychain lead', () => {
    const r = run(launchWith(configFile(true, { ...two, claudeAccount: 'riverbend' })), PLAIN);
    expect(r.code).toBe(2);
    expect(r.spawned).toHaveLength(0);
    expect(r.lines.join('\n')).toContain(`${TOKEN_SERVICE}.riverbend`);
  });

  it('refuses a config whose lead names an account not in claudeAccounts', () => {
    const r = run(dryRun(configFile(false, { ...two, claudeAccount: 'saltmarsh' })), BOTH);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toContain('not one of claudeAccounts');
  });

  it('prints in the dry run which account each lead resolves to, never a token', () => {
    const config = configFile(false, { ...two, defaultClaudeAccount: 'harborlight' });
    const plain = run(dryRun(config), BOTH);
    expect(plain.lines.join('\n')).toContain(
      `account harborlight, with the token in keychain item ${TOKEN_SERVICE}.harborlight`,
    );
    const moved = run(dryRun(config, '--claude-account', 'riverbend'), BOTH);
    expect(moved.lines.join('\n')).toContain('account riverbend');
    for (const r of [plain, moved]) {
      expect(r.reads).toEqual([]);
      expect(r.lines.join('\n')).not.toContain(TOKEN);
      expect(r.lines.join('\n')).not.toContain(OTHER);
    }
  });

  it('uses the un-labelled item when no account is named anywhere', () => {
    expect(resolveAccount({}, { claudeAccounts: [] })).toEqual({ ok: true, account: undefined });
    const r = run(launch(false), PLAIN);
    expect(r.reads).toEqual([TOKEN_SERVICE]);
  });
});

describe('the token', () => {
  it('decodes BASE64 and rejects what is not', () => {
    expect(decodeToken(STORED)).toBe(TOKEN);
    expect(decodeToken(null)).toBeNull();
    expect(decodeToken('')).toBeNull();
    expect(decodeToken('a b')).toBeNull();
  });

  it('is required for a walled lead and optional for an allowKeychain one', () => {
    expect(tokenEnv({ allowKeychain: false }, undefined, () => null).ok).toBe(false);
    expect(tokenEnv({ allowKeychain: true }, undefined, () => null)).toEqual({
      ok: true,
      env: {},
    });
  });
});

describe('the claude turn row', () => {
  const fake =
    (status: number, stdout: string): Spawn =>
    () => ({ status, stdout });

  it('is named as not run, not passed, without --turn', () => {
    let spawned = 0;
    const row = turnCheck({ allowKeychain: false }, '/p.sb', '/cwd', {
      turn: false,
      account: undefined,
      read: () => STORED,
      env: {},
      spawn: () => {
        spawned++;
        return { status: 0, stdout: 'ok' };
      },
    });
    expect(row.ran).toBe(false);
    expect(row.says).toContain('not run');
    expect(spawned).toBe(0);
  });

  it("runs with the lead's account's token under --turn, and fails a walled lead without one", () => {
    let env: Record<string, string | undefined> = {};
    const ran = turnCheck({ allowKeychain: false }, '/p.sb', '/cwd', {
      turn: true,
      account: 'riverbend',
      read: (service) => BOTH[service] ?? null,
      env: {},
      spawn: (_f, _a, opts) => {
        env = opts.env;
        return { status: 0, stdout: 'ok' };
      },
    });
    expect(ran).toMatchObject({ ran: true, ok: true });
    expect(ran.says).toContain('claude turn as riverbend:');
    expect(env[TOKEN_ENV]).toBe(OTHER);
    const missing = turnCheck({ allowKeychain: false }, '/p.sb', '/cwd', {
      turn: true,
      account: undefined,
      read: () => null,
      env: {},
      spawn: fake(0, 'ok'),
    });
    expect(missing).toMatchObject({ ran: true, ok: false });
    expect(missing.says).toContain(TOKEN_SERVICE);
  });

  it('holds when `claude -p` answers inside the profile', () => {
    const row = turnRow('/p.sb', '/cwd', { [TOKEN_ENV]: TOKEN }, fake(0, 'ok\n'));
    expect(row.ok).toBe(true);
    expect(row.says).toContain('answered: ok');
  });

  it('fails when it exits non-zero or says nothing, and never repeats the token', () => {
    expect(turnRow('/p.sb', '/cwd', {}, fake(1, 'OAuth token revoked')).ok).toBe(false);
    expect(turnRow('/p.sb', '/cwd', {}, fake(0, '')).ok).toBe(false);
    // Placed so an 80-character cut would split it.
    const echoed = turnRow(
      '/p.sb',
      '/cwd',
      { [TOKEN_ENV]: TOKEN },
      fake(0, `${'x'.repeat(70)}${TOKEN}`),
    );
    expect(echoed.says).not.toContain(TOKEN.slice(0, 10));
  });

  it('shows why on a failure that only stderr explains', () => {
    const row = turnRow('/p.sb', '/cwd', {}, () => ({
      status: 1,
      stdout: '',
      stderr: 'OAuth token revoked\n',
    }));
    expect(row.ok).toBe(false);
    expect(row.says).toContain('exited 1: OAuth token revoked');
  });
});
