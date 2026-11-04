/**
 * The tools a lead's config opens inside its wall (`lead-sandbox-tools.ts`):
 * the config key, the generated rules, and, where `sandbox-exec` exists, the
 * same rules under the real sandbox.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adbRow, bunWrapperRow } from './lead-sandbox-escapes.ts';
import { type Machine, SANDBOX_EXEC, buildProfile, parseConfig } from './lead-sandbox-lib.ts';
import {
  ADB_SDK,
  ADB_SERVER_PORT,
  LEAD_CACHE_DIR,
  UV_PYTHONS,
  bunWrapper,
  ensureLeadTools,
  leadToolsDir,
  toolNetworkRules,
} from './lead-sandbox-tools.ts';
import { CONNECT_PROBE } from './lead-sandbox-wall.ts';

function fixture(home: string, tools?: unknown) {
  const parsed = parseConfig(
    {
      leads: [
        {
          name: 'harborlight-lead',
          projects: [`${home}/dev/harborlight`],
          ...(tools === undefined ? {} : { tools }),
        },
      ],
    },
    home,
  );
  if (!parsed.ok) throw new Error(parsed.error);
  const lead = parsed.config.leads[0];
  if (!lead) throw new Error('fixture has no lead');
  return { lead, config: parsed.config };
}

const fakeMachine: Machine = { home: '/fixture/home/saltmarsh', uid: 501, realpath: (p) => p };

describe('the tools key', () => {
  it('is empty when the config names none', () => {
    expect(fixture(fakeMachine.home).lead.tools).toEqual([]);
  });

  it('refuses a name it does not know, a repeat, and a value that is not a list', () => {
    for (const tools of [['adb', 'adb'], ['keychain'], 'adb', [1]]) {
      const parsed = parseConfig(
        { leads: [{ name: 'harborlight-lead', projects: ['/p'], tools }] },
        fakeMachine.home,
      );
      expect(parsed.ok, JSON.stringify(tools)).toBe(false);
    }
  });
});

describe('adb in the generated profile', () => {
  it("refuses adb's port and leaves the SDK under the home deny, by default", () => {
    const { lead, config } = fixture(fakeMachine.home);
    const profile = buildProfile(lead, config, fakeMachine);
    expect(profile).toContain(`(deny network-outbound (remote ip "*:${ADB_SERVER_PORT}"))`);
    expect(profile).not.toContain(ADB_SDK);
  });

  it('opens the port and the SDK, read only, for a lead with adb', () => {
    const { lead, config } = fixture(fakeMachine.home, ['adb']);
    const profile = buildProfile(lead, config, fakeMachine);
    const sdk = `${fakeMachine.home}/${ADB_SDK}`;
    expect(profile).not.toContain(`"*:${ADB_SERVER_PORT}"`);
    expect(profile).toContain(`(allow file-read* (subpath "${sdk}"))`);
    // The read-only line comes after the grant, so the lead cannot swap adb.
    const lines = profile.split('\n');
    const grant = lines.findIndex((l) => l.startsWith(`(allow file-read* (subpath "${sdk}"))`));
    const nowrite = lines.findIndex((l) => l.startsWith(`(deny file-write* (subpath "${sdk}"))`));
    expect(grant).toBeGreaterThan(-1);
    expect(nowrite).toBeGreaterThan(grant);
  });
});

const HAVE_SANDBOX = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);

describe.skipIf(!HAVE_SANDBOX)('adb under the real sandbox-exec', () => {
  // A stand-in for adb's server on a port of this test's own, so nothing
  // touches 5037; the profile gets the same rule for that port.
  let root = '';
  let project = '';
  let sdk = '';
  let server: Server | null = null;
  let port = 0;
  const profiles: Record<'without' | 'with', string> = { without: '', with: '' };

  beforeAll(async () => {
    root = realpathSync(mkdtempSync('/private/tmp/lt-'));
    const home = join(root, 'home');
    project = join(home, 'dev', 'harborlight');
    sdk = join(home, ADB_SDK);
    mkdirSync(project, { recursive: true });
    mkdirSync(sdk, { recursive: true });
    writeFileSync(join(sdk, 'adb'), '#!/bin/sh\necho Android Debug Bridge version 1.0.41\n', {
      mode: 0o755,
    });
    server = await new Promise<Server>((done, fail) => {
      const s = createServer((c) => c.destroy());
      s.once('error', fail);
      s.listen(0, '127.0.0.1', () => done(s));
    });
    port = (server.address() as { port: number }).port;
    const m: Machine = { home, uid: 99999, realpath: (p) => p };
    for (const key of ['without', 'with'] as const) {
      const { lead, config } = fixture(home, key === 'with' ? ['adb'] : undefined);
      const file = join(root, `${key}.sb`);
      writeFileSync(
        file,
        `${buildProfile(lead, config, m)}${toolNetworkRules(lead, port).join('\n')}\n`,
      );
      profiles[key] = file;
    }
  });

  afterAll(() => {
    server?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const run = (profile: string, argv: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(SANDBOX_EXEC, ['-f', profile, ...argv], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  it('runs adb from the SDK only for a lead with adb', () => {
    expect(run(profiles.with, [join(sdk, 'adb')]).stdout.trim()).toContain('Android Debug Bridge');
    expect(run(profiles.without, [join(sdk, 'adb')]).status).not.toBe(0);
  });

  it("connects to adb's server only for a lead with adb", () => {
    const connect = (profile: string) =>
      run(profile, [process.execPath, '-e', CONNECT_PROBE], {
        HOST: '127.0.0.1',
        PORT: String(port),
      }).stdout.trim();
    expect(connect(profiles.with)).toBe('connected');
    expect(connect(profiles.without)).toBe('EPERM');
  });

  it('cannot replace adb, even with adb', () => {
    expect(run(profiles.with, ['/bin/sh', '-c', `echo x > '${join(sdk, 'adb')}'`]).status).not.toBe(
      0,
    );
  });

  it("passes --check's adb row for each lead, and fails it where adb is missing", () => {
    // The lead without adb probes 5037 itself: the profile refuses the
    // connect before it leaves the process, so no adb server is touched.
    const node = process.execPath;
    expect(adbRow(profiles.with, project, true, sdk, node).ok).toBe(true);
    expect(adbRow(profiles.without, project, false, sdk, node).ok).toBe(true);
    expect(adbRow(profiles.without, project, true, sdk, node).ok).toBe(false);
    expect(adbRow(profiles.with, project, true, join(root, 'no-sdk'), node).ok).toBe(false);
  });
});

describe('the bun wrapper and uv, written for a lead', () => {
  let home = '';
  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'lt-tools-')));
  });
  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('puts the wrapper first on PATH, and gives uv its own cache only with uv', () => {
    const plain = ensureLeadTools(
      { name: 'harborlight-lead', tools: [] },
      home,
      '/fixture/bin/bun',
      (p) => p,
      '/usr/bin:/bin',
    );
    const bin = join(leadToolsDir(home, 'harborlight-lead'), 'bin');
    expect(plain).toEqual({ PATH: `${bin}:/usr/bin:/bin` });
    const withUv = ensureLeadTools(
      { name: 'harborlight-lead', tools: ['uv'] },
      home,
      '/fixture/bin/bun',
      (p) => p,
      undefined,
    );
    expect(withUv.UV_CACHE_DIR?.startsWith(join(home, 'Library/Caches'))).toBe(true);
    expect(withUv.UV_TOOL_DIR?.startsWith(join(home, 'Library/Caches'))).toBe(true);
    expect(existsSync(join(bin, 'bun'))).toBe(true);
  });

  it('skips the install only for a bun in the plugin cache, by --cwd or by its folder', () => {
    const bin = join(home, 'wrapper-test');
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, 'bun');
    // A stand-in bun that prints what the wrapper handed it.
    const echo = join(bin, 'echo-bun');
    writeFileSync(
      echo,
      '#!/bin/sh\necho "skip=${BUN_CONFIG_SKIP_INSTALL_PACKAGES:-unset} args=$*"\n',
      { mode: 0o755 },
    );
    const plugins = join(home, '.claude', 'plugins');
    const plugin = join(plugins, 'cache', 'riverbend', 'p');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(wrapper, bunWrapper('harborlight-lead', echo, [plugins]), { mode: 0o755 });
    const at = (cwd: string, ...args: string[]) =>
      spawnSync(wrapper, args, {
        cwd,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      }).stdout.trim();
    expect(at(home, 'run', '--cwd', plugin, 'start')).toBe(`skip=1 args=run --cwd ${plugin} start`);
    expect(at(home, `--cwd=${plugin}`, 'install')).toBe(`skip=1 args=--cwd=${plugin} install`);
    expect(at(plugin, 'install')).toBe('skip=1 args=install');
    expect(at(home, 'install')).toBe('skip=unset args=install');
    // A sibling whose name only starts like the cache is not in it.
    const sibling = `${plugins}-not`;
    mkdirSync(sibling, { recursive: true });
    expect(at(sibling, 'install')).toBe('skip=unset args=install');
  });

  it('reads the wrapper folder and the uv Pythons, and writes only the uv cache', () => {
    const { lead, config } = fixture(fakeMachine.home, ['uv']);
    const profile = buildProfile(lead, config, fakeMachine);
    const tools = leadToolsDir(fakeMachine.home, lead.name);
    expect(profile).toContain(`(allow file-read* (subpath "${tools}"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${tools}"))`);
    expect(profile).toContain(`(allow file-read* (subpath "${fakeMachine.home}/${UV_PYTHONS}"))`);
    expect(profile).toContain(
      `(allow file-read* file-write* (subpath "${fakeMachine.home}/${LEAD_CACHE_DIR}/${lead.name}/uv"))`,
    );
    const plain = buildProfile(fixture(fakeMachine.home).lead, config, fakeMachine);
    expect(plain).not.toContain(UV_PYTHONS);
    expect(plain).not.toContain(LEAD_CACHE_DIR);
  });
});

const BUN = (() => {
  const r = spawnSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
})();

describe.skipIf(!HAVE_SANDBOX || BUN === null)(
  'a plugin MCP server under the real sandbox-exec',
  () => {
    // The shape of the Discord plugin's start: `bun run --cwd <plugin> start`,
    // whose script installs before it serves. The stand-in server answers one
    // MCP initialize. Its one dependency has a bin, so the install links one,
    // which is the write the wall refused.
    let root = '';
    let project = '';
    let plugin = '';
    let profile = '';
    let env: Record<string, string> = {};
    const INIT = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'probe', version: '0' },
      },
    })}\n`;

    beforeAll(() => {
      root = realpathSync(mkdtempSync('/private/tmp/lt-plugin-'));
      const home = join(root, 'home');
      project = join(home, 'dev', 'harborlight');
      plugin = join(home, '.claude', 'plugins', 'cache', 'riverbend', 'p');
      mkdirSync(project, { recursive: true });
      mkdirSync(join(plugin, 'dep'), { recursive: true });
      writeFileSync(
        join(plugin, 'package.json'),
        JSON.stringify({
          name: 'stand-in-plugin',
          scripts: { start: 'bun install --no-summary && bun server.ts' },
          dependencies: { 'stand-in-dep': 'file:./dep' },
        }),
      );
      writeFileSync(
        join(plugin, 'dep', 'package.json'),
        JSON.stringify({ name: 'stand-in-dep', version: '1.0.0', bin: { 'stand-in': 'cli.js' } }),
      );
      writeFileSync(join(plugin, 'dep', 'cli.js'), '#!/usr/bin/env node\n');
      writeFileSync(
        join(plugin, 'server.ts'),
        `process.stdin.once('data', (d) => {
  const msg = JSON.parse(String(d).split('\\n')[0]);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'stand-in' } } }) + '\\n');
  process.exit(0);
});\n`,
      );
      // Installed once outside the wall, as an unwalled session does.
      const installed = spawnSync(BUN ?? 'bun', ['install', '--no-summary'], {
        cwd: plugin,
        encoding: 'utf8',
      });
      if (installed.status !== 0) throw new Error(`setup install failed: ${installed.stderr}`);
      const m: Machine = { home, uid: 99999, realpath: (p) => p };
      const { lead, config } = fixture(home);
      profile = join(root, 'lead.sb');
      writeFileSync(profile, buildProfile(lead, config, m));
      env = ensureLeadTools(lead, home, BUN ?? 'bun', (p) => p, process.env.PATH);
    });

    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    const start = (path: string | undefined) =>
      spawnSync(
        SANDBOX_EXEC,
        ['-f', profile, 'bun', 'run', '--cwd', plugin, '--shell=bun', '--silent', 'start'],
        {
          cwd: project,
          encoding: 'utf8',
          input: INIT,
          timeout: 30_000,
          env: { ...process.env, ...(path ? { PATH: path } : {}) },
        },
      );

    it('fails at its install without the wrapper (the control), and answers initialize with it', () => {
      const plain = start(undefined);
      expect(plain.status).not.toBe(0);
      expect(plain.stderr).toContain('EPERM');
      const wrapped = start(env.PATH);
      expect(wrapped.stderr).toBe('');
      expect(JSON.parse(wrapped.stdout.trim())).toMatchObject({
        id: 1,
        result: { serverInfo: { name: 'stand-in' } },
      });
    }, 60_000);

    it("passes --check's wrapper row", () => {
      const wrapper = join(leadToolsDir(join(root, 'home'), 'harborlight-lead'), 'bin', 'bun');
      const row = bunWrapperRow(
        profile,
        project,
        wrapper,
        join(root, 'home', '.claude', 'plugins'),
      );
      expect(row.says).toContain('must be 1');
      expect(row.ok).toBe(true);
    });
  },
);

describe.skipIf(!HAVE_SANDBOX)('uv under the real sandbox-exec', () => {
  let root = '';
  let project = '';
  let home = '';
  const profiles: Record<'without' | 'with', string> = { without: '', with: '' };

  beforeAll(() => {
    root = realpathSync(mkdtempSync('/private/tmp/lt-uv-'));
    home = join(root, 'home');
    project = join(home, 'dev', 'harborlight');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(home, UV_PYTHONS), { recursive: true });
    writeFileSync(join(home, UV_PYTHONS, 'cpython'), 'a python\n');
    mkdirSync(join(home, '.cache', 'uv'), { recursive: true });
    // The launcher makes it outside the wall (ensureLeadTools).
    mkdirSync(join(home, LEAD_CACHE_DIR, 'harborlight-lead', 'uv'), { recursive: true });
    const m: Machine = { home, uid: 99999, realpath: (p) => p };
    for (const key of ['without', 'with'] as const) {
      const { lead, config } = fixture(home, key === 'with' ? ['uv'] : undefined);
      profiles[key] = join(root, `${key}.sb`);
      writeFileSync(profiles[key], buildProfile(lead, config, m));
    }
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const sh = (profile: string, script: string) =>
    spawnSync(SANDBOX_EXEC, ['-f', profile, '/bin/sh', '-c', script], {
      cwd: project,
      encoding: 'utf8',
    }).status;

  it("reads uv's Pythons and writes its own cache only with uv, and never the owner's cache", () => {
    const pythons = `cat '${join(home, UV_PYTHONS, 'cpython')}'`;
    const cache = join(home, LEAD_CACHE_DIR, 'harborlight-lead', 'uv');
    const write = `echo x > '${cache}/f'`;
    const owners = `echo x > '${join(home, '.cache', 'uv', 'f')}'`;
    const replace = `echo x > '${join(home, UV_PYTHONS, 'cpython')}'`;
    expect(sh(profiles.with, pythons), 'with: pythons').toBe(0);
    expect(sh(profiles.with, write), 'with: write').toBe(0);
    expect(sh(profiles.with, owners), 'with: owners').not.toBe(0);
    expect(sh(profiles.with, replace), 'with: replace').not.toBe(0);
    expect(sh(profiles.without, pythons), 'without: pythons').not.toBe(0);
    expect(sh(profiles.without, write), 'without: write').not.toBe(0);
  });
});
