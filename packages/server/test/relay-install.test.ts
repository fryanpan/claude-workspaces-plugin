/**
 * `bun run relay:install` (`infra/org-relay/install.ts`) over two real board
 * servers: one stands in for the Mac's loopback, one for a project machine
 * reached through a fake `fly ssh console` that runs the machine's curl
 * against it. launchctl is a fake that writes the relay's "running" line, and
 * HOME is a temp dir. Nothing here reaches fly, the Keychain or launchd.
 *
 * What this proves: a first run files each seat's outbox and inbox, mints the
 * relay's token on both boards, writes a config the relay accepts at mode
 * 600, loads the LaunchAgent and sets the lead's two Fly secrets on stdin; a
 * second run changes nothing it does not have to (no mint, no secret set, no
 * new task); `--remint` replaces a token and revokes the old record only
 * after the relay restarted; `--dry-run` writes, mints and files nothing; and
 * no token value appears in any argument, any line printed, or fly's stdin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
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
import { parseSeatList, redacted, serverPlans } from '../../../infra/org-relay/install-plan.ts';
import { type InstallIo, relayPaths, runInstall } from '../../../infra/org-relay/install.ts';
import { agentIdForName } from '../../core/src/identity.ts';
import { loadRelayConfig } from '../src/org-relay/relay-config.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const RELAY = 'agent-relay';
const TEAM_LEAD = 'agent-team-lead';
const LEAD = agentIdForName('riverbend-lead');
const HOST = 'riverbend.example';
const SEATS = JSON.stringify({
  relayAgentId: RELAY,
  macOrganization: 'harborlight',
  seats: [
    { id: 'team-lead', server: 'mac', agentId: TEAM_LEAD, crossOrganization: true },
    {
      id: 'riverbend-lead',
      project: 'riverbend',
      crossOrganization: true,
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
    machine = createServer({ port: 0, dataDir: tmp('relay-install-machine-') });
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
        const command = args[args.indexOf('--command') + 1] ?? '';
        const method = /-X (GET|POST)/.exec(command)?.[1] ?? 'GET';
        const path = /http:\/\/127\.0\.0\.1:8787([A-Za-z0-9_:./?=&-]*)/.exec(command)?.[1] ?? '/';
        if (path.endsWith('/revoke')) events.push('revoke');
        const b64 = /printf %s ([A-Za-z0-9+/=]+)/.exec(command)?.[1];
        const res = await fetch(`${base(machine)}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(b64 ? { body: Buffer.from(b64, 'base64').toString('utf8') } : {}),
        });
        return { status: 0, stdout: `${await res.text()}\n${res.status}\n`, stderr: '' };
      },
      launchctl: (args) => {
        launchctl.push(args);
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

  const home = tmp('relay-install-home-');
  const first = { tokens: [] as string[] };

  it('a dry run on a fresh Mac writes, mints and files nothing', async () => {
    const dryHome = tmp('relay-install-dry-');
    const h = harness(dryHome);
    const before = [(await records(mac)).length, (await records(machine)).length];
    expect(await runInstall({ dryRun: true, remint: false, boards: new Map() }, h.io)).toBe(0);
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
    expect(await runInstall({ dryRun: false, remint: false, boards: new Map() }, h.io)).toBe(0);
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
    expect(h.launchctl.map((a) => a[0])).toEqual(['print', 'bootstrap']);
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
    expect(leaks(h, first.tokens)).toEqual([]);
  });

  it('a second run mints nothing, files nothing and sets no secret', async () => {
    const h = harness(home);
    const before = [(await records(mac)).length, (await records(machine)).length];
    const config = readFileSync(relayPaths(home).config, 'utf8');
    expect(await runInstall({ dryRun: false, remint: false, boards: new Map() }, h.io)).toBe(0);
    expect([(await records(mac)).length, (await records(machine)).length]).toEqual(before);
    expect(readFileSync(relayPaths(home).config, 'utf8')).toBe(config);
    expect(await titles(machine, machineBoard)).toHaveLength(2);
    expect(h.fly.filter((c) => c.args[0] === 'secrets')).toEqual([]);
    expect(h.events).toEqual(['kickstart']);
    expect(h.out.join('\n')).toContain('already set');
    expect(h.out.join('\n')).toContain("keeps the relay's token on riverbend");
  });

  it('a dry run over an install prints no token value', async () => {
    const h = harness(home);
    expect(await runInstall({ dryRun: true, remint: false, boards: new Map() }, h.io)).toBe(0);
    expect(h.out.join('\n')).toContain('<redacted>');
    expect(leaks(h, first.tokens)).toEqual([]);
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
    expect(await runInstall({ dryRun: false, remint: false, boards: new Map() }, h.io)).toBe(0);
    expect((await records(mac)).length).toBe(before);
    expect(readFileSync(h.paths.config, 'utf8')).toContain(expired);
    expect(h.out.join('\n')).toContain('team-lead: mac answered');
  });

  it('--remint replaces both tokens and revokes the old records after the restart', async () => {
    const h = harness(home);
    const old = first.tokens.map((t) => t.split('.')[1]);
    expect(await runInstall({ dryRun: false, remint: true, boards: new Map() }, h.io)).toBe(0);
    const now = tokenValues(home);
    expect(now.filter((t) => first.tokens.includes(t))).toEqual([]);
    const revoked = [...(await records(mac)), ...(await records(machine))]
      .filter((r) => old.includes(r.id))
      .map((r) => r.revokedAt !== undefined);
    expect(revoked).toEqual([true, true]);
    expect(h.events).toEqual(['kickstart', 'revoke', 'revoke']);
    expect(h.out.join('\n')).toContain('it replaces record');
    expect(leaks(h, [...first.tokens, ...now])).toEqual([]);
  });

  it('names the board flag when a seat has no board to find', async () => {
    const h = harness(tmp('relay-install-none-'));
    h.io.seatsText = SEATS.replace(TEAM_LEAD, 'agent-nobody');
    await expect(
      runInstall({ dryRun: true, remint: false, boards: new Map() }, h.io),
    ).rejects.toThrow('pass --board team-lead=<board id>');
    expect(
      await runInstall(
        { dryRun: true, remint: false, boards: new Map([['team-lead', macBoard]]) },
        h.io,
      ),
    ).toBe(0);
  });
});

describe('relay:install plan', () => {
  const list = (extra: Record<string, unknown> = {}) =>
    parseSeatList(
      JSON.stringify({
        relayAgentId: RELAY,
        macOrganization: 'harborlight',
        seats: [{ id: 'riverbend-lead', project: 'riverbend', ...extra }],
      }),
      ['riverbend'],
    );
  const access = { ...OUTPUTS, access: { riverbend: { aud: 'x', hosts: [HOST] } } };

  it('a server behind Access needs the seat to name its service token', () => {
    expect(() => serverPlans(list(), access)).toThrow('accessToken');
    expect(serverPlans(list({ accessToken: 'relay riverbend' }), access)[0]).toMatchObject({
      accessInFront: true,
      accessToken: 'relay riverbend',
    });
    expect(serverPlans(list(), OUTPUTS)[0]?.accessInFront).toBe(false);
  });

  it('refuses a project machines.json does not list, and a restartFrom seat that does not exist', () => {
    expect(() => parseSeatList(SEATS, [])).toThrow('machines.json');
    expect(() => list({ restartFrom: ['nobody'] })).toThrow('restartFrom');
  });

  it('redacts token values and the service secret, keeping the record id', () => {
    const text = redacted(
      '{"bearers": {"w": "at2.rec1.agent-relay.w.99.MAC"}, "clientSecret": "s3cret"}',
    );
    expect(text).toContain('at2.rec1.<redacted>');
    expect(text).not.toContain('MAC');
    expect(text).not.toContain('s3cret');
  });
});
