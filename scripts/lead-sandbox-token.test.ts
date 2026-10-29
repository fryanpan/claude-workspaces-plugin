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
  tokenEnv,
  turnCheck,
  turnRow,
} from './lead-sandbox-token.ts';
import { type LaunchDeps, main } from './lead-sandbox.ts';

const TOKEN = 'sk-ant-oat01-test-harborlight-0000';
const STORED = `${Buffer.from(TOKEN).toString('base64')}\n`;

const root = mkdtempSync(join(tmpdir(), 'lead-sandbox-token-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function configFile(allowKeychain: boolean): string {
  const project = join(root, 'dev', 'harborlight');
  mkdirSync(project, { recursive: true });
  const file = join(root, `config-${allowKeychain}.json`);
  writeFileSync(
    file,
    JSON.stringify({ leads: [{ name: 'harborlight-lead', projects: [project], allowKeychain }] }),
  );
  return file;
}

interface Run {
  code: number;
  lines: string[];
  spawned: { file: string; args: string[]; env: Record<string, string | undefined> }[];
  reads: number;
}

function run(argv: string[], stored: string | null): Run {
  const out: Run = { code: 0, lines: [], spawned: [], reads: 0 };
  const deps: LaunchDeps = {
    platform: 'darwin',
    say: (line) => out.lines.push(line),
    readToken: () => {
      out.reads++;
      return stored;
    },
    spawn: (file, args, opts) => {
      out.spawned.push({ file, args, env: opts.env });
      return 0;
    },
  };
  out.code = main(argv, deps);
  return out;
}

const launch = (allowKeychain: boolean) => [
  '--config',
  configFile(allowKeychain),
  '--profiles',
  join(root, 'profiles'),
  '--lead',
  'harborlight-lead',
  '--',
  'claude',
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
    const r = run(launch(false), STORED);
    expect(r.code).toBe(0);
    expect(r.spawned).toHaveLength(1);
    expect(r.spawned[0]?.env[TOKEN_ENV]).toBe(TOKEN);
    expect(r.spawned[0]?.args).not.toContain(TOKEN);
  });

  it('refuses the launch, naming the item and `claude setup-token`, when the item is missing', () => {
    const r = run(launch(false), null);
    expect(r.code).toBe(2);
    expect(r.spawned).toHaveLength(0);
    const said = r.lines.join('\n');
    expect(said).toContain(TOKEN_SERVICE);
    expect(said).toContain('claude setup-token');
  });

  it('refuses a stored value that is not BASE64', () => {
    const r = run(launch(false), 'not base64!');
    expect(r.code).toBe(2);
    expect(r.spawned).toHaveLength(0);
  });

  it('launches an allowKeychain lead without a token', () => {
    const r = run(launch(true), null);
    expect(r.code).toBe(0);
    expect(r.spawned).toHaveLength(1);
    expect(r.spawned[0]?.env[TOKEN_ENV]).toBeUndefined();
  });

  it('never writes the value to stdout, stderr or the dry run', () => {
    const runs = [
      run(launch(false), STORED),
      run(['--config', configFile(false), '--profiles', join(root, 'profiles')], STORED),
    ];
    for (const r of runs) expect(r.lines.join('\n')).not.toContain(TOKEN);
    expect(written.join('')).not.toContain(TOKEN);
    expect(written.join('')).not.toContain(STORED.trim());
  });

  it('does not read the keychain for a dry run', () => {
    const r = run(['--config', configFile(false), '--profiles', join(root, 'profiles')], STORED);
    expect(r.code).toBe(0);
    expect(r.reads).toBe(0);
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
    expect(tokenEnv({ allowKeychain: false }, () => null).ok).toBe(false);
    expect(tokenEnv({ allowKeychain: true }, () => null)).toEqual({ ok: true, env: {} });
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

  it('runs with the token under --turn, and fails a walled lead without one', () => {
    let env: Record<string, string | undefined> = {};
    const ran = turnCheck({ allowKeychain: false }, '/p.sb', '/cwd', {
      turn: true,
      read: () => STORED,
      env: {},
      spawn: (_f, _a, opts) => {
        env = opts.env;
        return { status: 0, stdout: 'ok' };
      },
    });
    expect(ran).toMatchObject({ ran: true, ok: true });
    expect(env[TOKEN_ENV]).toBe(TOKEN);
    const missing = turnCheck({ allowKeychain: false }, '/p.sb', '/cwd', {
      turn: true,
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
