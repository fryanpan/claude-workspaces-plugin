/**
 * The tools a lead's config opens inside its wall (`lead-sandbox-tools.ts`):
 * the config key, the generated rules, and, where `sandbox-exec` exists, the
 * same rules under the real sandbox.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adbRow } from './lead-sandbox-escapes.ts';
import { type Machine, SANDBOX_EXEC, buildProfile, parseConfig } from './lead-sandbox-lib.ts';
import { ADB_SDK, ADB_SERVER_PORT, toolNetworkRules } from './lead-sandbox-tools.ts';
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
