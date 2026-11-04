/**
 * The daily wall report's drift checks: the on-machine reader
 * (`machine-facts.ts`), the judges (`wall-drift.ts`) and the reads that feed
 * them (`wall-drift-read.ts`), each against stand-ins. Nothing here calls
 * Fly, GitHub or Cloudflare, or reads a real machine.
 */
import { describe, expect, it } from 'bun:test';
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import type { StaticVars } from '../../../infra/cloudflare/vars.ts';
import {
  type FactsIo,
  type MachineFacts,
  githubRepos,
  readFacts,
} from '../../../infra/project-machine/machine-facts.ts';
import {
  type DriftIo,
  READ_STATE_ENTRY,
  READ_TOKEN_ENTRY,
  driftRows,
  readOnlyCloudflare,
} from '../../../infra/project-machine/wall-drift-read.ts';
import {
  deployKeyRows,
  flyRows,
  gitPushRows,
  ingressRows,
  oneAddressRows,
  planRows,
  serviceTokenRows,
  settingsRows,
  uidRows,
} from '../../../infra/project-machine/wall-drift.ts';

const OWNER = 'alice@example.com';
const HOST = 'riverbend.harborlight.test';
const PUB = 'ssh-ed25519 AAAAC3NzaRiverbendFixtureKey';

/** What `machine:deploy` would set on Riverbend's server. */
const EXPECTED = new Map([
  ['CW_OWNER_EMAIL', OWNER],
  ['CW_PUBLIC_BASE_URL', `https://${HOST}`],
  ['CF_ACCESS_TEAM_DOMAIN', 'harborlight.cloudflareaccess.com'],
  ['CF_ACCESS_AUD', 'aud-r'],
  ['CF_ACCESS_HOST_AUDS', JSON.stringify({ [HOST]: 'aud-r' })],
  ['CW_PROXIED_TRUSTED_HOSTS', HOST],
]);

/** A machine set up exactly as the deploy sets one up. */
function facts(over: Partial<MachineFacts> = {}): MachineFacts {
  return {
    server: {
      ...Object.fromEntries(EXPECTED),
      CW_LOOPBACK_SKIPS_ACCESS: '1',
      CW_LOOPBACK_REFUSED_UIDS: '10004',
    },
    cloudflared: 'named',
    users: [
      { name: 'cw', uid: 10001 },
      { name: 'cwtunnel', uid: 10002 },
      { name: 'lead', uid: 10004 },
    ],
    gitPush: {
      state: 'ok',
      rules: [{ board: 'w-riverbend', repo: 'alice/riverbend', approval: true }],
    },
    deployKey: PUB,
    repos: ['alice/riverbend'],
    ...over,
  };
}

const failing = (rows: Array<{ check: string; answer: string; ok: boolean }>) =>
  rows.filter((r) => !r.ok).map((r) => `${r.check}: ${r.answer}`);

describe('the on-machine reader', () => {
  const io = (over: Partial<FactsIo> = {}): FactsIo => ({
    procs: () => [
      {
        cmdline: ['bun', 'run', '/app/packages/server/src/bin.ts', '--port', '8787'],
        environ: () => ({
          CW_OWNER_EMAIL: OWNER,
          CW_LOOPBACK_REFUSED_UIDS: '10004',
          CW_GITHUB_PUSH_TOKEN: 'fixture-token-saltmarsh',
        }),
      },
      {
        cmdline: ['/usr/local/bin/cloudflared', 'tunnel', '--no-autoupdate', 'run'],
        environ: () => ({}),
      },
    ],
    read: (path) =>
      ({
        '/data/cw/git-push.json': JSON.stringify({
          boards: { 'w-riverbend': { repos: [{ repo: 'alice/riverbend', approval: true }] } },
        }),
        '/data/lead/work/riverbend/.git/config':
          '[remote "origin"]\n\turl = git@github.com:alice/riverbend.git\n',
        '/etc/passwd':
          'root:x:0:0::/root:/bin/sh\ncw:x:10001:10001::/home/cw:/bin/sh\nlead:x:10004:10004::/home/lead:/bin/sh\nnobody:x:65534:65534::/:/bin/false\n',
      })[path] ?? null,
    dirs: () => ['/data/lead/work/riverbend'],
    publicKey: () => `${PUB} lead@riverbend\n`,
    ...over,
  });

  it('keeps only the named server settings, and the public half of the deploy key', () => {
    const f = readFacts(io());
    expect(f.server).toEqual({ CW_OWNER_EMAIL: OWNER, CW_LOOPBACK_REFUSED_UIDS: '10004' });
    expect(JSON.stringify(f)).not.toContain('fixture-token-saltmarsh');
    expect(f.cloudflared).toBe('named');
    expect(f.users).toEqual([
      { name: 'cw', uid: 10001 },
      { name: 'lead', uid: 10004 },
    ]);
    expect(f.gitPush).toEqual({
      state: 'ok',
      rules: [{ board: 'w-riverbend', repo: 'alice/riverbend', approval: true }],
    });
    expect(f.deployKey).toBe(PUB);
    expect(f.repos).toEqual(['alice/riverbend']);
  });

  it('says when there is no server, a quick tunnel, or a policy that does not parse', () => {
    const f = readFacts(
      io({
        procs: () => [
          {
            cmdline: ['cloudflared', 'tunnel', '--url', 'http://localhost:8787'],
            environ: () => ({}),
          },
        ],
        read: (p) => (p === '/data/cw/git-push.json' ? '{"boards": 7}' : null),
        publicKey: () => null,
      }),
    );
    expect([f.server, f.cloudflared, f.gitPush.state, f.deployKey]).toEqual([
      null,
      'quick',
      'unparseable',
      null,
    ]);
    expect(
      githubRepos('url = https://github.com/bob/harborlight\nurl = git@gitlab.com:x/y.git'),
    ).toEqual(['bob/harborlight']);
  });
});

describe('the drift judges', () => {
  it('a machine set up as the deploy sets it up passes every check', () => {
    const f = facts();
    expect(failing(settingsRows('riverbend', EXPECTED, f))).toEqual([]);
    expect(failing(uidRows('riverbend', f))).toEqual([]);
    expect(failing(gitPushRows('riverbend', f))).toEqual([]);
    const keys = { 'alice/riverbend': [{ key: `${PUB} deploy`, read_only: true }] };
    expect(failing(deployKeyRows('riverbend', f, keys))).toEqual([]);
    const ingress = {
      ingress: [
        { hostname: HOST, service: 'http://localhost:8787' },
        { service: 'http_status:404' },
      ],
    };
    expect(failing(ingressRows('riverbend', HOST, ingress, f))).toEqual([]);
  });

  it('reports a changed audience, a widened trusted list and an unset host list, printing no value', () => {
    const f = facts();
    const server = {
      ...f.server,
      CF_ACCESS_AUD: 'aud-other',
      CW_PROXIED_TRUSTED_EMAILS: `${OWNER},bob@example.com`,
      CW_PROXIED_TRUSTED_HOSTS: undefined,
    };
    const rows = settingsRows('riverbend', EXPECTED, { ...f, server });
    expect(failing(rows)).toEqual([
      'CF_ACCESS_AUD: differs from the deploy',
      'CW_PROXIED_TRUSTED_HOSTS: not set on the server',
      'CW_PROXIED_TRUSTED_EMAILS: 1 address(es) besides the owner',
    ]);
    expect(JSON.stringify(rows)).not.toContain('bob@example.com');
    expect(JSON.stringify(rows)).not.toContain('aud-other');
  });

  it('reports a lead the loopback door admits, and names who else it admits', () => {
    const f = facts();
    const rows = uidRows('riverbend', {
      ...f,
      server: { ...f.server, CW_LOOPBACK_REFUSED_UIDS: '' },
    });
    expect(failing(rows)).toEqual(['loopback refuses the lead: uid 10004 admitted']);
    expect(rows[1]?.answer).toBe('cwtunnel 10002, lead 10004');
  });

  it('lists a push without approval as intended, and fails a policy the server cannot read', () => {
    const f = facts({
      gitPush: {
        state: 'ok',
        rules: [{ board: 'w-riverbend', repo: 'alice/riverbend', approval: false }],
      },
    });
    const rows = gitPushRows('riverbend', f);
    expect(failing(rows)).toEqual([]);
    expect(rows[0]?.answer).toBe(
      'board w-riverbend: pushes without approval; a .github/ change waits',
    );
    expect(
      gitPushRows('riverbend', facts({ gitPush: { state: 'absent', rules: [] } }))[0]?.ok,
    ).toBe(true);
    expect(
      gitPushRows('riverbend', facts({ gitPush: { state: 'unparseable', rules: [] } }))[0]?.ok,
    ).toBe(false);
  });

  it('reports a deploy key that can write, or that is on no repo it looked at', () => {
    const f = facts();
    expect(
      failing(
        deployKeyRows('riverbend', f, { 'alice/riverbend': [{ key: PUB, read_only: false }] }),
      ),
    ).toEqual(['deploy key is read-only: alice/riverbend: can write']);
    expect(failing(deployKeyRows('riverbend', f, { 'alice/riverbend': null }))).toEqual([
      'deploy key is read-only: not found on alice/riverbend (could not read alice/riverbend)',
    ]);
    expect(deployKeyRows('riverbend', facts({ deployKey: null }), {})[0]?.ok).toBe(true);
  });

  it('reports ingress that serves another host, an extra rule, or a quick tunnel', () => {
    const f = facts();
    const wide = {
      ingress: [
        { hostname: HOST, service: 'http://localhost:8787' },
        { hostname: 'harborlight.harborlight.test', service: 'http://localhost:8787' },
        { service: 'http_status:404' },
      ],
    };
    expect(failing(ingressRows('riverbend', HOST, wide, f))).toEqual([
      'tunnel ingress: 3 rule(s), not the expected two',
    ]);
    expect(failing(ingressRows('riverbend', HOST, null, facts({ cloudflared: 'quick' })))).toEqual([
      'cloudflared: quick',
      'tunnel ingress: could not be read',
    ]);
  });

  it('checks each Fly app for its own network and nothing published', () => {
    const view = {
      apps: [
        { Name: 'cw-harborlight', Network: 'cw-harborlight' },
        { Name: 'cw-riverbend', Network: 'cw-harborlight' },
      ],
      ips: { 'cw-riverbend': [{ Type: 'v6' }, { Type: 'private_v6' }] },
      machines: {
        'cw-harborlight': [{ id: 'm1', config: { services: [{ internal_port: 8787 }] } }],
      },
    };
    expect(failing(flyRows(['harborlight', 'riverbend'], view))).toEqual([
      'Fly network: cw-harborlight, shared with riverbend',
      'no Fly service: services on m1',
      'Fly network: cw-harborlight, shared with harborlight',
      'no public address: public: v6',
    ]);
    expect(
      failing(flyRows(['riverbend'], { apps: [{ Name: 'cw-riverbend' }], ips: {}, machines: {} })),
    ).toEqual(['Fly network: Fly did not name it']);
  });

  it('needs ONE_ADDRESS_ORIGIN once there is a second origin', () => {
    const v = {
      project_origins: { riverbend: 'riverbend-origin.harborlight.test' },
      board_origins: { 'mac.harborlight.test': ['w-1'] },
      one_address_origin: '',
    };
    expect(failing(oneAddressRows(v))).toEqual(['ONE_ADDRESS_ORIGIN: unset with 2 origin(s)']);
    expect(failing(oneAddressRows({ ...v, one_address_origin: 'mac.harborlight.test' }))).toEqual(
      [],
    );
    expect(failing(oneAddressRows({ ...v, project_origins: {} }))).toEqual([]);
  });

  it('reports a service token two projects admit', () => {
    const p = (tokens: string[]) => ({
      hosts: [],
      emails: [],
      email_domains: [],
      service_tokens: tokens,
    });
    expect(
      failing(serviceTokenRows({ harborlight: p(['home-feed']), riverbend: p(['home-feed']) })),
    ).toEqual(["service token is one project's: home-feed: harborlight, riverbend"]);
  });

  it('reads the Cloudflare plan: no changes passes, each change is a row, no plan fails', () => {
    expect(planRows(0, 'Cloudflare plan for prod: ...\n\nNo changes.\n')[0]?.ok).toBe(true);
    expect(failing(planRows(0, 'head\n\n- change `module.stack.module.access.x`\n'))).toEqual([
      'Cloudflare drifted from the config: change `module.stack.module.access.x`',
    ]);
    expect(planRows(1, '')[0]?.ok).toBe(false);
  });
});

describe('the reads behind them', () => {
  const outputs: TfOutputs = {
    access: { riverbend: { aud: 'aud-r', hosts: [HOST] } },
    accessTeamDomain: 'harborlight.cloudflareaccess.com',
    tunnels: {
      riverbend: {
        account_id: 'f'.repeat(32),
        id: '11111111-2222-4333-8444-555555555555',
        name: 'cw-riverbend',
        origin: 'riverbend-origin.harborlight.test',
        public_host: HOST,
      },
    },
  };

  function io(over: Partial<DriftIo> = {}): { io: DriftIo; asked: string[] } {
    const asked: string[] = [];
    const base: DriftIo = {
      fly: <T>(args: string[]) => {
        asked.push(`fly ${args.join(' ')}`);
        if (args[0] === 'apps') return [{ Name: 'cw-riverbend', Network: 'cw-riverbend' }] as T;
        return [] as T;
      },
      exec: (app, command) => {
        asked.push(`${app}: ${command.split(' ').at(-1)}`);
        return `Connecting...\n${JSON.stringify(facts())}\n`;
      },
      repoKeys: (repo) => {
        asked.push(`keys ${repo}`);
        return [{ key: PUB, read_only: true }];
      },
      ingress: async () => ({
        ingress: [
          { hostname: HOST, service: 'http://localhost:8787' },
          { service: 'http_status:404' },
        ],
      }),
      expected: () => EXPECTED,
      routerVars: () =>
        ({
          project_origins: { riverbend: 'riverbend-origin.harborlight.test' },
          board_origins: {},
          one_address_origin: '',
          access_projects: {},
        }) as unknown as StaticVars,
      plan: async () => ({ status: 0, summary: 'No changes.\n' }),
    };
    return { io: { ...base, ...over }, asked };
  }

  it('a machine and account that match pass, and every read is one the report names', async () => {
    const { io: i, asked } = io();
    const rows = await driftRows(['riverbend'], outputs, i);
    expect(failing(rows)).toEqual([]);
    expect(asked).toEqual([
      'fly apps list',
      'fly ips list --app cw-riverbend',
      'fly machine list --app cw-riverbend',
      'cw-riverbend: machine',
      'keys alice/riverbend',
    ]);
  });

  it('a machine that does not answer, a config it cannot read and a drifted plan all fail', async () => {
    const { io: i } = io({
      exec: () => {
        throw new Error('fly ssh console failed');
      },
      routerVars: () => {
        throw new Error('router.local.json is missing');
      },
      plan: async () => ({ status: 0, summary: '- change `module.stack.module.tunnel.y`\n' }),
    });
    expect(failing(await driftRows(['riverbend'], outputs, i))).toEqual([
      'machine probe: did not answer',
      'router and Access config: could not be read: router.local.json is missing',
      'Cloudflare drifted from the config: change `module.stack.module.tunnel.y`',
    ]);
  });
});

describe('the Cloudflare credentials the report reads with', () => {
  const kc = (entries: Record<string, string>) => ({
    keychainHas: (n: string) => n in entries,
    keychainRead: (n: string) => entries[n] ?? '',
  });

  it('takes only the read-only token and state key', () => {
    const ro = readOnlyCloudflare(
      kc({
        [READ_TOKEN_ENTRY]: 'fixture-read-token-riverbend\n',
        [READ_STATE_ENTRY]: JSON.stringify({ accessKeyId: 'ro-id', secretAccessKey: 'ro-secret' }),
        'cloudflare-api-token': 'fixture-apply-token-harborlight',
      }),
    );
    expect(ro).toEqual({
      token: 'fixture-read-token-riverbend',
      state: { AWS_ACCESS_KEY_ID: 'ro-id', AWS_SECRET_ACCESS_KEY: 'ro-secret' },
    });
  });

  it('never falls back to the apply token or the read-write state key', () => {
    const apply = {
      'cloudflare-api-token': 'fixture-apply-token-harborlight',
      'cloudflare-r2-tfstate': JSON.stringify({ accessKeyId: 'rw', secretAccessKey: 'rw' }),
    };
    expect(() => readOnlyCloudflare(kc(apply))).toThrow(`the Keychain has no ${READ_TOKEN_ENTRY}`);
    expect(() =>
      readOnlyCloudflare(kc({ ...apply, [READ_TOKEN_ENTRY]: 'fixture-read-token-riverbend' })),
    ).toThrow(`the Keychain has no ${READ_STATE_ENTRY}`);
    expect(() =>
      readOnlyCloudflare(
        kc({ [READ_TOKEN_ENTRY]: 'fixture-read-token-riverbend', [READ_STATE_ENTRY]: 'not json' }),
      ),
    ).toThrow('has no accessKeyId and secretAccessKey');
  });
});
