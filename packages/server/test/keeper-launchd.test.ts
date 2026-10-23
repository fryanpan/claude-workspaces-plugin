/**
 * launchd holds the keeper's port, and the keeper answers behind it on a
 * unix socket.
 *
 * The plist cases read the generated XML back through `plutil`, as launchd
 * would. The last case bootstraps a real job in this user's own launchd
 * domain, so it runs only with CW_KEEPER_LAUNCHD_TESTS=1 on a Mac.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keeperJobPlist, portJobPlist } from '../src/keeper/keeper-launchd.ts';
import type { Executors } from '../src/keeper/keeper-requests.ts';
import { serveKeeper } from '../src/keeper/keeper-serve.ts';
import { openKeeperStore } from '../src/keeper/keeper-store.ts';

const darwin = process.platform === 'darwin';
const tmp = mkdtempSync(join(tmpdir(), 'keeper-launchd-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const exec: Executors = {
  fly: async () => ({ status: 0, stdout: '', stderr: '' }),
  cloudflare: async () => ({ status: 200, body: '{}' }),
};

const openStore = () => {
  const dir = mkdtempSync(join(tmp, 'store-'));
  const s = openKeeperStore(dir);
  if ('error' in s) throw new Error(s.error);
  return s;
};

/** A plist as launchd reads it. */
const parsed = (xml: string): Record<string, unknown> => {
  const r = Bun.spawnSync(['/usr/bin/plutil', '-convert', 'json', '-o', '-', '-'], {
    stdin: new TextEncoder().encode(xml),
  });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout.toString()) as Record<string, unknown>;
};

const job = { user: 'cw-relay', port: 8797, socketPath: '/Users/cw-relay/keeper/run/keeper.sock' };

describe.skipIf(!darwin)('the port job', () => {
  it('has launchd listen on both loopback addresses and relay to the socket', () => {
    expect(parsed(portJobPlist(job))).toEqual({
      Label: 'com.claude-workspaces.keeper-port',
      UserName: 'cw-relay',
      ProgramArguments: ['/usr/bin/nc', '-U', job.socketPath],
      inetdCompatibility: { Wait: false },
      Sockets: {
        v4: {
          SockNodeName: '127.0.0.1',
          SockServiceName: '8797',
          SockType: 'stream',
          SockProtocol: 'TCP',
        },
        v6: {
          SockNodeName: '::1',
          SockServiceName: '8797',
          SockType: 'stream',
          SockProtocol: 'TCP',
        },
      },
    });
  });

  it('runs the keeper on the socket the port job relays to', () => {
    const keeper = parsed(
      keeperJobPlist({ ...job, root: '/Users/cw-relay/keeper', home: '/Users/cw-relay' }),
    ) as { EnvironmentVariables: Record<string, string>; Sockets?: unknown };
    expect(keeper.EnvironmentVariables.CW_KEEPER_SOCKET).toBe(job.socketPath);
    expect(keeper.EnvironmentVariables.CW_KEEPER_PORT).toBe('8797');
    // The keeper job holds no TCP listener of its own.
    expect(keeper.Sockets).toBeUndefined();
  });
});

describe('a relayed keeper', () => {
  it('answers on its unix socket, as the origin launchd holds', async () => {
    const run = mkdtempSync(join(tmp, 'run-'));
    const socketPath = join(run, 'k.sock');
    const keeper = serveKeeper({ store: openStore(), exec, port: 8797, unix: socketPath });
    try {
      const r = await fetch('http://localhost:8797/', {
        unix: socketPath,
        headers: { host: 'localhost:8797' },
      });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('Waiting for your passkey');
      expect(keeper.origin).toBe('http://localhost:8797');
    } finally {
      await keeper.stop();
    }
  });

  it('refuses a socket folder another user could write', () => {
    const run = join(tmp, 'open-run');
    mkdirSync(run);
    chmodSync(run, 0o755);
    expect(() =>
      serveKeeper({ store: openStore(), exec, port: 8797, unix: join(run, 'k.sock') }),
    ).toThrow("must belong to the keeper's user with mode 700");
    // CONTROL: the same folder closed to everyone else is accepted.
    chmodSync(run, 0o700);
    const keeper = serveKeeper({ store: openStore(), exec, port: 8797, unix: join(run, 'k.sock') });
    return keeper.stop();
  });
});

const bindable = (hostname: string, port: number): boolean => {
  try {
    Bun.serve({ hostname, port, fetch: () => new Response('x') }).stop(true);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!darwin || !process.env.CW_KEEPER_LAUNCHD_TESTS)('under launchd', () => {
  it('no process can take the port while the job is loaded, keeper up or down', async () => {
    const port = 18797;
    const free = 18798;
    const label = 'com.claude-workspaces.keeper-port-test';
    const domain = `gui/${process.getuid?.()}`;
    // A unix socket path must stay under 104 bytes.
    const run = mkdtempSync('/tmp/kl-');
    const socketPath = join(run, 'k.sock');
    const plistPath = join(tmp, `${label}.plist`);
    writeFileSync(plistPath, portJobPlist({ label, port, socketPath }));
    expect(bindable('127.0.0.1', port)).toBe(true);
    const boot = Bun.spawnSync(['launchctl', 'bootstrap', domain, plistPath]);
    expect(boot.exitCode).toBe(0);
    try {
      const keeper = serveKeeper({ store: openStore(), exec, port, unix: socketPath });
      try {
        for (const host of ['localhost', '127.0.0.1', '[::1]']) {
          const r = await fetch(`http://${host}:${port}/`);
          expect({ host, status: r.status }).toEqual({ host, status: 200 });
        }
        expect([bindable('127.0.0.1', port), bindable('::1', port)]).toEqual([false, false]);
      } finally {
        await keeper.stop();
      }
      // The keeper is down, as in a restart: the port is still held.
      expect([bindable('127.0.0.1', port), bindable('::1', port)]).toEqual([false, false]);
      // CONTROL: a port no job holds binds.
      expect(bindable('127.0.0.1', free)).toBe(true);
    } finally {
      Bun.spawnSync(['launchctl', 'bootout', `${domain}/${label}`]);
      rmSync(run, { recursive: true, force: true });
    }
  }, 30_000);
});
