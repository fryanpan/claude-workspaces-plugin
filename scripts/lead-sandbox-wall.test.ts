/**
 * The board wall (`lead-sandbox-wall.ts`). The first half reads the
 * generated profile; the second runs it under the real `/usr/bin/sandbox-exec`
 * and skips, saying so, where there is none (Linux CI).
 *
 * The live cases listen on spare ports of their own and never connect to a
 * board server's port: a refused connect answers EPERM whether or not
 * anything listens, which is what tells the wall from an empty port.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOARD_SERVER_PORTS, STAGING_PORTS } from '../packages/server/src/reserved-ports.ts';
import { boardWallRows, connectFrom } from './lead-sandbox-escapes.ts';
import { type Machine, SANDBOX_EXEC, buildProfile, parseConfig } from './lead-sandbox-lib.ts';
import { boardWallRules, wallHosts } from './lead-sandbox-wall.ts';

function fixture(home: string, boardWall: unknown) {
  const parsed = parseConfig(
    { leads: [{ name: 'harborlight-lead', projects: [`${home}/dev/harborlight`], boardWall }] },
    home,
  );
  if (!parsed.ok) throw new Error(parsed.error);
  const lead = parsed.config.leads[0];
  if (!lead) throw new Error('fixture has no lead');
  return { lead, config: parsed.config };
}

const fakeMachine: Machine = { home: '/fixture/home/saltmarsh', uid: 501, realpath: (p) => p };

describe('the generated profile', () => {
  it("denies every board server's port, at every address, for a lead with boardWall", () => {
    const { lead, config } = fixture(fakeMachine.home, true);
    const profile = buildProfile(lead, config, fakeMachine);
    for (const port of BOARD_SERVER_PORTS)
      expect(profile).toContain(`(deny network-outbound (remote ip "*:${port}"))`);
    expect(BOARD_SERVER_PORTS).toContain(8787);
  });

  it('leaves the ports open for a lead without it, so a real lead is unchanged', () => {
    const { lead, config } = fixture(fakeMachine.home, undefined);
    expect(lead.boardWall).toBe(false);
    const profile = buildProfile(lead, config, fakeMachine);
    for (const port of BOARD_SERVER_PORTS) expect(profile).not.toContain(`*:${port}`);
  });

  it('refuses a boardWall that is not true or false', () => {
    const parsed = parseConfig(
      { leads: [{ name: 'harborlight-lead', projects: ['/a'], boardWall: 'yes' }] },
      fakeMachine.home,
    );
    expect(parsed.ok).toBe(false);
  });

  it('covers every port staging may take', () => {
    for (const port of STAGING_PORTS) expect(BOARD_SERVER_PORTS).toContain(port);
  });

  it('lists both loopbacks and each outside address, never a link-local one', () => {
    const hosts = wallHosts({
      en0: [
        { address: '192.0.2.10', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      utun4: [{ address: '100.64.0.7', family: 'IPv4', internal: false }],
    });
    expect(hosts).toEqual(['127.0.0.1', '::1', '192.0.2.10', '100.64.0.7']);
  });
});

const HAVE_SANDBOX = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
if (!HAVE_SANDBOX)
  console.warn(`lead-sandbox-wall: ${SANDBOX_EXEC} is missing, so the real-sandbox cases skip.`);

function listen(host: string | { path: string }): Promise<Server> {
  return new Promise((done, fail) => {
    const s = createServer((c) => c.destroy());
    s.once('error', fail);
    if (typeof host === 'string') s.listen(0, host, () => done(s));
    else s.listen(host.path, () => done(s));
  });
}

const portOf = (s: Server) => (s.address() as { port: number }).port;

describe.skipIf(!HAVE_SANDBOX)('the wall under the real sandbox-exec', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lead-wall-')));
  const home = join(root, 'home');
  const project = join(home, 'dev', 'harborlight');
  mkdirSync(project, { recursive: true });
  const m: Machine = { home, uid: 99999, realpath: (p) => p };
  const { lead, config } = fixture(home, true);
  const walled = join(root, 'walled.sb');
  const unwalled = join(root, 'unwalled.sb');
  const socketPath = join(root, 'lead.sock');
  // The board ports stand in for no listener here; `walledPort` and
  // `openPort` are this test's own listeners, at both loopbacks.
  const servers: Server[] = [];
  let walledPort = 0;
  let openPort = 0;

  beforeAll(async () => {
    const v4 = await listen('127.0.0.1');
    walledPort = portOf(v4);
    const v6 = await new Promise<Server>((done, fail) => {
      const s = createServer((c) => c.destroy());
      s.once('error', fail);
      s.listen(walledPort, '::1', () => done(s));
    });
    const open = await listen('127.0.0.1');
    openPort = portOf(open);
    servers.push(v4, v6, open, await listen({ path: socketPath }));
    // The generated profile, plus the same rule for this test's port.
    const extra = boardWallRules(true, [walledPort]).join('\n');
    writeFileSync(walled, `${buildProfile(lead, config, m)}${extra}\n`);
    writeFileSync(unwalled, buildProfile({ ...lead, boardWall: false }, config, m));
  });

  afterAll(() => {
    for (const s of servers) s.close();
    rmSync(root, { recursive: true, force: true });
  });

  const node = process.execPath;

  it('refuses a listening port at both loopbacks, and connects without the wall (the control)', () => {
    for (const host of ['127.0.0.1', '::1']) {
      expect(connectFrom(node, unwalled, project, host, walledPort), host).toBe('connected');
      expect(connectFrom(node, walled, project, host, walledPort), host).toBe('EPERM');
    }
  });

  it('still connects to a port the wall does not name, and to a unix socket', () => {
    expect(connectFrom(node, walled, project, '127.0.0.1', openPort)).toBe('connected');
    const r = spawnSync(
      SANDBOX_EXEC,
      [
        '-f',
        walled,
        node,
        '-e',
        `const s = require('node:net').connect(process.env.SOCK);
s.on('connect', () => { console.log('connected'); s.destroy(); });
s.on('error', (e) => console.log(e.code));`,
      ],
      { cwd: project, encoding: 'utf8', env: { ...process.env, SOCK: socketPath } },
    );
    expect(r.stdout.trim()).toBe('connected');
  });

  it("refuses every board server's port at every address this machine has", () => {
    // Inside the wall only: a denied connect never leaves this process, so
    // nothing listening there (prod, or another builder's staging) is touched.
    for (const host of wallHosts(networkInterfaces()))
      for (const port of BOARD_SERVER_PORTS)
        expect(connectFrom(node, walled, project, host, port), `${host}:${port}`).toBe('EPERM');
  }, 120_000);

  it('passes the check rows with the wall and fails them without it (the mutation control)', () => {
    const at = (profile: string) =>
      boardWallRows(profile, unwalled, project, ['127.0.0.1', '::1'], [walledPort], node);
    expect(
      at(walled)
        .filter((r) => !r.ok)
        .map((r) => r.says),
    ).toEqual([]);
    expect(at(unwalled).map((r) => r.ok)).toEqual([false, false]);
  });
});
