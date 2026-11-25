/**
 * `bun run relay:install` (`infra/org-relay/install.ts`) over two real board
 * servers: one stands in for the Mac's loopback, one for a project machine
 * reached through a fake `fly ssh console` that runs the machine's curl
 * against it through a real sh. The machine runs `better-auth` with no Access
 * in front, as a project machine does. launchctl is a fake that writes the
 * relay's "running" line, and HOME is a temp dir. Nothing here reaches fly,
 * the Keychain or launchd.
 *
 * What this proves: a first run files each seat's outbox and inbox, mints the
 * relay's token on both boards, writes a config the relay accepts at mode
 * 600, loads the LaunchAgent and sets the lead's two Fly secrets on stdin; it
 * puts a token minted for Team Lead into the Mac's home-remotes file, and the
 * machine takes the Mac's escalation ack with that token and refuses it with
 * the relay's; a
 * second run changes nothing it does not have to (no mint, no secret set, no
 * new task, no restart); `--remint` replaces every token and revokes the old
 * records only once the check passes; `--dry-run` writes, mints and files nothing; and
 * no token value appears in any argument, any line printed, or fly's stdin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import {
  type InstallIo,
  type InstallOptions,
  relayPaths,
  runInstall,
} from '../../../infra/org-relay/install.ts';
import { agentIdForName } from '../../core/src/identity.ts';
import { OWNER_SIGNIN_FILE } from '../src/auth/owner-signin-record.ts';
import { loadRelayConfig } from '../src/org-relay/relay-config.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const RELAY = 'agent-relay';
const TEAM_LEAD = 'agent-team-lead';
const LEAD = agentIdForName('riverbend-lead');
const HOST = 'riverbend.example';
const OWNER = 'owner@harborlight.test';
const SEATS = JSON.stringify({
  relayAgentId: RELAY,
  macOrganization: 'harborlight',
  seats: [
    { id: 'team-lead', server: 'mac', agentId: TEAM_LEAD, crossOrganization: true },
    {
      id: 'riverbend-lead',
      project: 'riverbend',
      restartFrom: ['team-lead'],
    },
  ],
});
const OUTPUTS: TfOutputs = {
  access: {},
  accessTeamDomain: null,
  tunnels: {
    riverbend: { account_id: 'a', id: 't', name: 'riverbend', origin: 'o', public_host: HOST },
  },
};

interface FlyCall {
  args: string[];
  input?: string;
}

describe('relay:install', () => {
  const dirs: string[] = [];
  const tmp = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
  let mac: ServerHandle;
  let machine: ServerHandle;
  let macBoard = '';
  let machineBoard = '';
  const base = (h: ServerHandle) => `http://127.0.0.1:${h.port}`;
  const send = async (h: ServerHandle, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base(h)}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const records = async (h: ServerHandle) =>
    (await send(h, 'GET', '/api/board-tokens')).body.tokens as Array<{
      id: string;
      revokedAt?: number;
    }>;
  const titles = async (h: ServerHandle, board: string) =>
    (
      (await send(h, 'GET', `/workspaces/${board}/tasks?format=json`)).body.tasks as Array<{
        title: string;
      }>
    ).map((t) => t.title);

  beforeAll(async () => {
    mac = createServer({ port: 0, dataDir: tmp('relay-install-mac-') });
    // The project machine's shape: the owner signed in once, so `better-auth`
    // is in force and no Access is in front, which is what makes the Mac's
    // escalation ack need a token minted for Team Lead.
    const machineDir = tmp('relay-install-machine-');
    writeFileSync(
      join(machineDir, OWNER_SIGNIN_FILE),
      JSON.stringify({ email: OWNER, at: '2026-11-19T10:00:00.000Z' }),
      { mode: 0o600 },
    );
    machine = createServer({
      port: 0,
      dataDir: machineDir,
      proxiedTrustedHosts: [HOST],
      proxiedTrustedEmails: [OWNER],
      signIn: {
        mode: 'better-auth',
        origin: `https://${HOST}`,
        google: { clientId: 'shared-client', clientSecret: 'stub-secret' },
      },
    });
    const board = async (h: ServerHandle, name: string, lead: string) => {
      const author = { id: 'agent-setup', name: 'setup', kind: 'agent' };
      const created = await send(h, 'POST', '/workspaces', { name, author });
      const id = (created.body.workspace as { id: string }).id;
      expect(
        (
          await send(h, 'PUT', `/workspaces/${id}/lead`, {
            leadAgentId: lead,
            author: { id: lead, name: lead, kind: 'agent' },
          })
        ).status,
      ).toBe(200);
      return id;
    };
    macBoard = await board(mac, 'Harborlight fleet', TEAM_LEAD);
    machineBoard = await board(machine, 'Riverbend project', LEAD);
    // A second board on the machine, led by somebody else: the lookup must skip it.
    await board(machine, 'Saltmarsh side', 'agent-saltmarsh');
  });
  afterAll(async () => {
    await mac?.stop();
    await machine?.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** The machine's `env -i`, `setpriv` and `curl`: the first two drop their
   *  options and run the rest, logging who they would run it as; curl is the
   *  real one, sent to the test machine instead of port 8787. */
  const stubs = tmp('relay-install-stubs-');
  const stubLog = join(stubs, 'log');
  const stub = (name: string, body: string) => {
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  stub(
    'env',
    'while [ $# -gt 0 ]; do case "$1" in -i|*=*) shift;; *) break;; esac; done\nexec "$@"',
  );
  stub(
    'setpriv',
    'echo "setpriv $1" >> "$STUB_LOG"\nwhile [ $# -gt 0 ]; do [ "$1" = "--" ] && { shift; break; }; shift; done\nexec "$@"',
  );
  stub('curl', 'exec /usr/bin/curl --connect-to "127.0.0.1:8787:127.0.0.1:$TEST_PORT" "$@"');

  /** The homes whose relay agent the fake launchd holds, across runs. */
  const loaded = new Set<string>();
  /** One install's IO, with every call and line it made. */
  function harness(home: string) {
    const fly: FlyCall[] = [];
    const launchctl: string[][] = [];
    const out: string[] = [];
    /** launchctl verbs and revokes, in the order they happened. */
    const events: string[] = [];
    const paths = relayPaths(home);
    const io: InstallIo = {
      home,
      uid: 501,
      seatsText: SEATS,
      projects: ['riverbend'],
      outputs: () => OUTPUTS,
      fetch: (url, init) => {
        if (url.endsWith('/revoke')) events.push('revoke');
        return fetch(
          url.replace('http://127.0.0.1:8787', base(mac)).replace(`https://${HOST}`, base(machine)),
          init,
        );
      },
      fly: async (args, input) => {
        fly.push({ args, ...(input !== undefined ? { input } : {}) });
        if (args[0] === 'secrets') return { status: 0, stdout: '', stderr: '' };
        // The command a machine would run, run here by a real sh: only env,
        // setpriv and curl are stubs (`stubs`), so every quoting layer
        // `machineShell` and `asCw` add is parsed for real.
        const command = args[args.indexOf('--command') + 1] ?? '';
        if (command.includes('/revoke')) events.push('revoke');
        const p = Bun.spawn(['/bin/sh', '-c', command], {
          env: {
            PATH: `${stubs}:/usr/bin:/bin`,
            TEST_PORT: String(machine.port),
            STUB_LOG: stubLog,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
        ]);
        return { status: await p.exited, stdout, stderr };
      },
      launchctl: (args) => {
        launchctl.push(args);
        const target = args[args.length - 1] ?? '';
        if (target.endsWith('/com.fryanpan.claude-workspaces')) {
          events.push('server-restart');
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] !== 'print') events.push(args[0] as string);
        if (args[0] === 'print')
          return { status: loaded.has(home) ? 0 : 113, stdout: '', stderr: '' };
        if (args[0] === 'bootout') loaded.delete(home);
        if (args[0] === 'bootstrap' || args[0] === 'kickstart') {
          loaded.add(home);
          // What relay-bin.ts writes once it accepts the config.
          const config = loadRelayConfig(paths.config);
          if (!('error' in config)) {
            appendFileSync(
              paths.log,
              `[relay] running: ${config.seats.size} seats on ${config.servers.size} servers\n`,
            );
          }
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      keychain: () => {
        throw new Error('no seat here reads the Keychain');
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      out: (line) => out.push(line),
      startWaitMs: 5_000,
    };
    return { io, fly, launchctl, out, paths, events };
  }

  /** Every token value either server ever issued to the relay. */
  const tokenValues = (home: string): string[] => {
    const text = readFileSync(relayPaths(home).config, 'utf8');
    return [...text.matchAll(/"(at2\.[^"]+)"/g)].map((m) => m[1] as string);
  };
  const leaks = (h: ReturnType<typeof harness>, tokens: string[]) => {
    const seen = [
      ...h.out,
      ...h.fly.flatMap((c) => [...c.args, c.input ?? '']),
      ...h.launchctl.flat(),
    ].join('\n');
    return tokens.filter((t) => seen.includes(t));
  };

  /** The Mac's home-remotes file for one home, kept outside it. */
  const remotesFiles = new Map<string, string>();
  const remotesFile = (h: string) => {
    let path = remotesFiles.get(h);
    if (!path) {
      path = join(tmp('relay-install-remotes-'), 'home-remotes.json');
      const body = {
        address: 'https://one.harborlight.test',
        self: 'mac.harborlight.test',
        boardOrigins: { 'mac.harborlight.test': [macBoard], [HOST]: [machineBoard] },
      };
      writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
      remotesFiles.set(h, path);
    }
    return path;
  };
  const opts = (h: string, more: Partial<InstallOptions> = {}): InstallOptions => ({
    dryRun: false,
    remint: false,
    boards: new Map(),
    homeRemotes: remotesFile(h),
    ...more,
  });
  const homeToken = (h: string) =>
    (JSON.parse(readFileSync(remotesFile(h), 'utf8')) as { boardTokens?: Record<string, string> })
      .boardTokens?.[machineBoard];
  /** The Mac's escalation ack, as it arrives through the tunnel. */
  const ack = (token: string) =>
    fetch(`${base(machine)}/workspaces/${machineBoard}/home-feed/escalation-ack`, {
      method: 'POST',
      headers: {
        host: HOST,
        'cf-ray': '8a1b2c3d4e5f-SJC',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ deadSince: Date.now() - 60_000 }),
    });

  const home = tmp('relay-install-home-');
  const first = { tokens: [] as string[], home: '' };
  const text0 = (h: { out: string[] }) => h.out.join('\n');

  it('a dry run on a fresh Mac writes, mints and files nothing', async () => {
    const dryHome = tmp('relay-install-dry-');
    const h = harness(dryHome);
    const before = [(await records(mac)).length, (await records(machine)).length];
    expect(await runInstall(opts(h.io.home, { dryRun: true }), h.io)).toBe(0);
    expect([(await records(mac)).length, (await records(machine)).length]).toEqual(before);
    expect(await titles(machine, machineBoard)).toEqual([]);
    expect(readdirSync(dryHome)).toEqual([]);
    expect(h.fly.filter((c) => c.args[0] === 'secrets')).toEqual([]);
    expect(h.launchctl).toEqual([]);
    const text = h.out.join('\n');
    expect(text).toContain("would mint the relay's token on riverbend");
    expect(text).toContain('would set on cw-riverbend');
    expect(text).toContain('restarts the machine');
  });

  it('installs: tasks, tokens, a 600 config the relay accepts, the agent, the secrets', async () => {
    const h = harness(home);
    expect(await runInstall(opts(h.io.home), h.io)).toBe(0);
    expect((await titles(mac, macBoard)).sort()).toEqual([
      'Relay inbox: team-lead',
      'Relay outbox: team-lead',
    ]);
    expect((await titles(machine, machineBoard)).sort()).toEqual([
      'Relay inbox: riverbend-lead',
      'Relay outbox: riverbend-lead',
    ]);
    expect(statSync(h.paths.config).mode & 0o777).toBe(0o600);
    const config = loadRelayConfig(h.paths.config);
    if ('error' in config) throw new Error(config.error);
    const seat = config.seats.get('riverbend-lead');
    expect(seat?.board).toBe(machineBoard);
    expect(seat?.restartFrom).toEqual(['team-lead']);
    expect(config.servers.get('riverbend')?.baseUrl).toBe(`https://${HOST}`);
    expect(config.seats.get('team-lead')?.board).toBe(macBoard);
    const plist = readFileSync(h.paths.plist, 'utf8');
    expect(plist).toContain(`<string>${h.paths.config}</string>`);
    expect(plist).toContain('CW_RELAY_STATE_DIR');
    // The program the agent runs is relay-bin.ts in the checkout it names.
    const program = /<string>([^<]*relay-bin\.ts)<\/string>/.exec(plist)?.[1] ?? '';
    expect(program.startsWith(`${h.paths.repo}/`)).toBe(true);
    expect(existsSync(join(REPO_ROOT, program.slice(h.paths.repo.length)))).toBe(true);
    expect(plist).toContain(`<string>${h.paths.bun}</string>`);
    // Every machine call ran as cw.
    expect(new Set(readFileSync(stubLog, 'utf8').trim().split('\n'))).toEqual(
      new Set(['setpriv --reuid=cw']),
    );
    expect(h.events).toEqual(['server-restart', 'bootstrap']);
    // Home's token for the machine's board is Team Lead's, so the Mac's
    // escalation ack is taken; the relay's own token is refused there.
    const homeTok = homeToken(home) ?? '';
    expect(homeTok.split('.')[2]).toBe(TEAM_LEAD);
    expect(statSync(remotesFile(home)).mode & 0o777).toBe(0o600);
    expect((await ack(homeTok)).status).toBe(200);
    const relayTok = tokenValues(home).find((t) => t.split('.')[3] === machineBoard) ?? '';
    expect((await ack(relayTok)).status).toBe(403);
    expect(text0(h)).toContain(`board ${machineBoard}: its home feed answered`);
    first.home = homeTok;
    const secrets = h.fly.filter((c) => c.args[0] === 'secrets');
    expect(secrets.map((c) => c.args)).toEqual([['secrets', 'import', '--app', 'cw-riverbend']]);
    expect(secrets[0]?.input).toBe(
      `CW_LEAD_INBOX_DOC=${seat?.inboxDoc}\nCW_RELAY_AGENT_ID=${RELAY}\n`,
    );
    const text = h.out.join('\n');
    expect(text).toContain('logged "running: 2 seats"');
    expect(text).toContain('riverbend-lead: riverbend answered');
    expect(text).toContain('team-lead: mac answered');
    first.tokens = tokenValues(home);
    expect(first.tokens).toHaveLength(2);
    expect(leaks(h, [...first.tokens, first.home])).toEqual([]);
  });

  it('a second run mints nothing, files nothing and sets no secret', async () => {
    const h = harness(home);
    const before = [(await records(mac)).length, (await records(machine)).length];
    const config = readFileSync(relayPaths(home).config, 'utf8');
    expect(await runInstall(opts(h.io.home), h.io)).toBe(0);
    expect([(await records(mac)).length, (await records(machine)).length]).toEqual(before);
    expect(readFileSync(relayPaths(home).config, 'utf8')).toBe(config);
    expect(await titles(machine, machineBoard)).toHaveLength(2);
    expect(h.fly.filter((c) => c.args[0] === 'secrets')).toEqual([]);
    expect(h.events).toEqual([]);
    expect(text0(h)).toContain("keeps Home's token");
    expect(h.out.join('\n')).toContain('logged "running: 2 seats"');
    expect(h.out.join('\n')).toContain('already set');
    expect(h.out.join('\n')).toContain("keeps the relay's token on riverbend");
  });

  it('a dry run over an install prints no token value', async () => {
    const h = harness(home);
    expect(await runInstall(opts(h.io.home, { dryRun: true }), h.io)).toBe(0);
    expect(h.out.join('\n')).toContain('<redacted>');
    expect(leaks(h, [...first.tokens, first.home])).toEqual([]);
  });

  it('refuses to guess where Home keeps its tokens', async () => {
    const h = harness(tmp('relay-install-noremotes-'));
    await expect(
      runInstall({ dryRun: true, remint: false, boards: new Map() }, h.io),
    ).rejects.toThrow('--home-remotes');
  });

  it('keeps a token the relay renewed, though the config value has expired', async () => {
    const h = harness(home);
    const live = first.tokens.find((t) => t.split('.')[3] === macBoard) as string;
    const f = live.split('.');
    // The value the config was written with, long expired; the relay renewed
    // it into bearers.json, which names the value it was renewed from.
    const expired = [f[0], f[1], f[2], f[3], '1', f[5]].join('.');
    const text = readFileSync(h.paths.config, 'utf8').replace(live, expired);
    writeFileSync(h.paths.config, text, { mode: 0o600 });
    chmodSync(h.paths.config, 0o600);
    mkdirSync(h.paths.stateDir, { recursive: true });
    const from = createHash('sha256').update(expired).digest('hex');
    writeFileSync(
      join(h.paths.stateDir, 'bearers.json'),
      JSON.stringify({ mac: { [macBoard]: { value: live, from } } }),
      { mode: 0o600 },
    );
    const before = (await records(mac)).length;
    expect(await runInstall(opts(h.io.home), h.io)).toBe(0);
    expect((await records(mac)).length).toBe(before);
    expect(readFileSync(h.paths.config, 'utf8')).toContain(expired);
    expect(h.out.join('\n')).toContain('team-lead: mac answered');
  });

  it('keeps asking a server that is restarting until it answers', async () => {
    const h = harness(home);
    const real = h.io.fetch;
    let refused = 0;
    h.io.fetch = (url, init) => {
      if (url.startsWith(`https://${HOST}`) && refused < 3) {
        refused++;
        return Promise.resolve(new Response('restarting', { status: 502 }));
      }
      return real(url, init);
    };
    h.io.sleep = async () => {};
    expect(await runInstall(opts(h.io.home), h.io)).toBe(0);
    expect(refused).toBe(3);
    expect(h.out.join('\n')).toContain('riverbend-lead: riverbend answered');
  });

  it('--remint replaces both tokens and revokes the old records once the check passes', async () => {
    const h = harness(home);
    const old = first.tokens.map((t) => t.split('.')[1]);
    expect(await runInstall(opts(h.io.home, { remint: true }), h.io)).toBe(0);
    const now = tokenValues(home);
    expect(now.filter((t) => first.tokens.includes(t))).toEqual([]);
    const revoked = [...(await records(mac)), ...(await records(machine))]
      .filter((r) => old.includes(r.id))
      .map((r) => r.revokedAt !== undefined);
    expect(revoked).toEqual([true, true]);
    expect(h.events).toEqual(['server-restart', 'kickstart', 'revoke', 'revoke', 'revoke']);
    // Home's token was replaced too, and the old one revoked.
    const homeNow = homeToken(home) ?? '';
    expect(homeNow).not.toBe(first.home);
    const oldHome = (await records(machine)).find((r) => r.id === first.home.split('.')[1]);
    expect(oldHome?.revokedAt).toBeDefined();
    expect((await ack(homeNow)).status).toBe(200);
    expect(h.out.join('\n')).toContain('it replaces record');
    expect(leaks(h, [...first.tokens, ...now])).toEqual([]);
  });

  it('names the board flag when a seat has no board to find', async () => {
    const h = harness(tmp('relay-install-none-'));
    h.io.seatsText = SEATS.replace(TEAM_LEAD, 'agent-nobody');
    await expect(runInstall(opts(h.io.home, { dryRun: true }), h.io)).rejects.toThrow(
      'pass --board team-lead=<board id>',
    );
    expect(
      await runInstall(
        opts(h.io.home, { dryRun: true, boards: new Map([['team-lead', macBoard]]) }),
        h.io,
      ),
    ).toBe(0);
  });
});
