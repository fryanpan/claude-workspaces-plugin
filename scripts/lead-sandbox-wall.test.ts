/**
 * The board wall (`lead-sandbox-wall.ts`). The first half reads the
 * generated profile; the second runs it under the real `/usr/bin/sandbox-exec`
 * and skips, saying so, where there is none (Linux CI).
 *
 * The live cases listen on spare ports and sockets of their own and never
 * connect to a board server: a refused connect answers EPERM whether or not
 * anything listens, which is what tells the wall from an empty port.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { type Server, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOARD_SERVER_PORTS, STAGING_PORTS } from '../packages/server/src/reserved-ports.ts';
import {
  boardSocketRows,
  boardWallRows,
  connectFrom,
  socketConnectFrom,
} from './lead-sandbox-escapes.ts';
import { type Machine, SANDBOX_EXEC, buildProfile, parseConfig } from './lead-sandbox-lib.ts';
import { boardWallRules, socketDirEnds, wallHosts } from './lead-sandbox-wall.ts';

function fixture(home: string, boardWall: unknown, boardSocketDir?: string, boardId = 'w-harbor') {
  const parsed = parseConfig(
    {
      leads: [
        { name: 'harborlight-lead', projects: [`${home}/dev/harborlight`], boardWall, boardId },
      ],
      ...(boardSocketDir ? { boardSocketDir } : {}),
    },
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

  it("denies the board socket folder, at both ends of /tmp, and allows only its own board's socket", () => {
    const { lead, config } = fixture(fakeMachine.home, true);
    const profile = buildProfile(lead, config, fakeMachine);
    for (const dir of ['/private/tmp/cw-501-boards', '/tmp/cw-501-boards']) {
      expect(profile).toContain(`(deny network-outbound (remote unix-socket (subpath "${dir}")))`);
      expect(profile).toContain(
        `(allow network-outbound (remote unix-socket (path-literal "${dir}/w-harbor.sock")))`,
      );
      expect(profile).toContain(`(deny file-write* (subpath "${dir}"))`);
    }
    // Scoped to the folder: the lead's other local sockets keep working.
    expect(profile).not.toContain('(remote unix-socket))');
    expect(profile).not.toContain('w-river');
  });

  it('takes the socket folder from the config', () => {
    const { lead, config } = fixture(fakeMachine.home, true, '/private/var/cw/boards');
    const profile = buildProfile(lead, config, fakeMachine);
    expect(profile).toContain('(subpath "/private/var/cw/boards")');
    expect(profile).not.toContain('cw-501-boards');
  });

  it('spells a folder under /tmp both ways, and one elsewhere once', () => {
    expect(socketDirEnds('/tmp/b', (p) => p)).toEqual(['/tmp/b', '/private/tmp/b']);
    expect(socketDirEnds('/private/tmp/b', (p) => p)).toEqual(['/private/tmp/b', '/tmp/b']);
    expect(socketDirEnds('/opt/b', (p) => p)).toEqual(['/opt/b']);
  });

  it('leaves the ports and sockets open for a lead without it, so a real lead is unchanged', () => {
    const { lead, config } = fixture(fakeMachine.home, undefined);
    expect(lead.boardWall).toBe(false);
    const profile = buildProfile(lead, config, fakeMachine);
    for (const port of BOARD_SERVER_PORTS) expect(profile).not.toContain(`*:${port}`);
    expect(profile).not.toContain('cw-501-boards');
  });

  it('refuses a boardWall that is not true or false, or one with no board', () => {
    const lead = (o: Record<string, unknown>) =>
      parseConfig(
        { leads: [{ name: 'harborlight-lead', projects: ['/a'], ...o }] },
        fakeMachine.home,
      );
    expect(lead({ boardWall: 'yes', boardId: 'w-harbor' }).ok).toBe(false);
    expect(lead({ boardWall: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining('boardId'),
    });
    expect(lead({ boardWall: true, boardId: '../w-river' }).ok).toBe(false);
    expect(lead({ boardWall: true, boardId: 'w-harbor' }).ok).toBe(true);
  });

  it('refuses a socket folder too long for a socket path, or not absolute', () => {
    const dir = (boardSocketDir: unknown) =>
      parseConfig(
        { leads: [{ name: 'harborlight-lead', projects: ['/a'] }], boardSocketDir },
        fakeMachine.home,
      );
    expect(dir(`/private/tmp/${'x'.repeat(90)}`)).toMatchObject({
      ok: false,
      error: expect.stringContaining('too long'),
    });
    expect(dir('tmp/boards').ok).toBe(false);
    expect(dir('/private/tmp/cw-"x').ok).toBe(false);
    expect(dir('/private/tmp/cw-501-boards').ok).toBe(true);
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
  // Every path is made in beforeAll, which a skipped suite never runs: on
  // Linux there is no /private/tmp. Under /private/tmp, not tmpdir(): a unix
  // socket path is limited to 104 bytes, and the per-user temp folder leaves
  // too few for a board's.
  let root = '';
  let project = '';
  let boards = '';
  let own = '';
  let other = '';
  let walled = '';
  let unwalled = '';
  let socketPath = '';
  // Links the lead could have made in its own project, to another board's socket.
  let symlink = '';
  let hardlink = '';
  // A lead whose own board's socket path is itself a link to Riverbend's.
  let linkedLead = '';
  let linkedOwn = '';
  // The board ports stand in for no listener here; `walledPort` and
  // `openPort` are this test's own listeners, at both loopbacks.
  const servers: Server[] = [];
  let walledPort = 0;
  let openPort = 0;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync('/private/tmp/lw-'));
    const home = join(root, 'home');
    project = join(home, 'dev', 'harborlight');
    mkdirSync(project, { recursive: true });
    boards = join(root, 'b');
    mkdirSync(boards);
    own = join(boards, 'w-harbor.sock');
    other = join(boards, 'w-river.sock');
    const m: Machine = { home, uid: 99999, realpath: (p) => p };
    const { lead, config } = fixture(home, true, boards);
    walled = join(root, 'walled.sb');
    unwalled = join(root, 'unwalled.sb');
    socketPath = join(root, 'lead.sock');
    symlink = join(project, 'r.sock');
    hardlink = join(project, 'h.sock');
    linkedLead = join(root, 'linked.sb');
    linkedOwn = join(boards, 'w-salt.sock');
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
    servers.push(await listen({ path: own }), await listen({ path: other }));
    symlinkSync(other, symlink);
    linkSync(other, hardlink);
    symlinkSync(other, linkedOwn);
    // The generated profile, plus the same rule for this test's port.
    const extra = boardWallRules(lead, boards, (p) => p, [walledPort]).join('\n');
    writeFileSync(walled, `${buildProfile(lead, config, m)}${extra}\n`);
    writeFileSync(unwalled, buildProfile({ ...lead, boardWall: false }, config, m));
    const saltmarsh = fixture(home, true, boards, 'w-salt');
    writeFileSync(linkedLead, buildProfile(saltmarsh.lead, saltmarsh.config, m));
  });

  afterAll(() => {
    for (const s of servers) s.close();
    if (root) rmSync(root, { recursive: true, force: true });
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

  it("connects to its own board's socket, inside the wall and without it", () => {
    expect(socketConnectFrom(node, unwalled, project, own)).toBe('connected');
    expect(socketConnectFrom(node, walled, project, own)).toBe('connected');
  });

  it("refuses another board's socket, a symlink to it and a hard link to it, each of which connects without the wall", () => {
    // The folder spelled through /tmp as well as /private/tmp, the other
    // end of the symlink a connect may name.
    const alias = other.replace(/^\/private\//, '/');
    for (const path of [other, symlink, hardlink, alias]) {
      expect(socketConnectFrom(node, unwalled, project, path), path).toBe('connected');
      expect(socketConnectFrom(node, walled, project, path), path).toBe('EPERM');
    }
  });

  it("refuses its own board's path when that is a link to another board's socket", () => {
    expect(socketConnectFrom(node, null, project, linkedOwn)).toBe('connected');
    expect(socketConnectFrom(node, linkedLead, project, linkedOwn)).toBe('EPERM');
  });

  it('may write nothing in the socket folder, which it may without the wall', () => {
    const write = (profile: string, name: string) =>
      spawnSync(SANDBOX_EXEC, ['-f', profile, '/bin/ln', '-s', other, join(boards, name)], {
        cwd: project,
        encoding: 'utf8',
      }).status;
    expect(write(unwalled, 'control.sock')).toBe(0);
    expect(write(walled, 'w-plant.sock')).not.toBe(0);
    expect(existsSync(join(boards, 'w-plant.sock'))).toBe(false);
  });

  it('fails a check row whose path has no socket behind it, which proves nothing', () => {
    // Measured: such a connect answers ENOENT inside the wall too.
    const rows = boardSocketRows(
      walled,
      unwalled,
      project,
      own,
      [join(boards, 'w-none.sock')],
      node,
    );
    expect(rows.map((r) => r.ok)).toEqual([true, false]);
  });

  it('passes the socket check rows with the wall and fails them without it (the mutation control)', () => {
    const at = (profile: string) =>
      boardSocketRows(profile, unwalled, project, own, [other, symlink, hardlink], node);
    expect(
      at(walled)
        .filter((r) => !r.ok)
        .map((r) => r.says),
    ).toEqual([]);
    expect(at(unwalled).map((r) => r.ok)).toEqual([true, false, false, false]);
  });
});
