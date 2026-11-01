/**
 * `infra/cloudflare/discover.ts` against a fake account: which live resources
 * a plan adopts by name, and what it refuses before terraform runs. The answers
 * have the shapes Cloudflare's API documents, with invented ids. Nothing here
 * calls Cloudflare.
 */
import { describe, expect, it } from 'bun:test';
import { discover } from '../../../infra/cloudflare/discover.ts';
import type { EnvNames, StaticVars } from '../../../infra/cloudflare/vars.ts';
import type { CloudflareApi } from '../../../infra/project-machine/cloudflare.ts';

const ZONE = 'harborlight.test';
const ACCOUNT = 'a'.repeat(32);
const ZONE_ID = 'f'.repeat(32);
const TUNNEL_ID = '11111111-2222-4333-8444-555555555555';
const RIVER_HOST = `riverbend-workspaces.${ZONE}`;
const RIVER_ORIGIN = `riverbend-origin.${ZONE}`;
const MAC_ORIGIN = `mac-origin.${ZONE}`;

const PROD: EnvNames = {
  name_prefix: '',
  router_script_name: 'board-router',
  share_link_script_name: 'share-link-gate',
};

const vars = (over: Partial<StaticVars> = {}): StaticVars => ({
  zone: ZONE,
  one_address: `workspaces.${ZONE}`,
  project_origins: { riverbend: RIVER_ORIGIN, saltmarsh: MAC_ORIGIN },
  project_hosts: { riverbend: RIVER_HOST, saltmarsh: `saltmarsh-workspaces.${ZONE}` },
  board_origins: {},
  bind_board_paths: false,
  one_address_origin: '',
  tunnels: {
    riverbend: { name: 'cw-riverbend', origin: RIVER_ORIGIN, public_host: RIVER_HOST },
  },
  access_session_duration: '24h',
  access_projects: {
    riverbend: {
      hosts: [RIVER_HOST],
      emails: ['alice@harborlight.test'],
      email_domains: [],
      service_tokens: ['relay riverbend'],
    },
  },
  share_link_routes: [],
  ...over,
});

interface Account {
  apps: Array<Record<string, unknown>>;
  policies: Array<{ id: string; name: string }>;
  tokens: Array<{ id: string; name: string }>;
  scripts: Array<{ id: string }>;
  routes: Array<{ id: string; pattern: string; script?: string }>;
  records: Array<{ id: string; type: string; name: string; content: string; proxied: boolean }>;
  tunnels: Array<Record<string, unknown>>;
  certHosts: string[];
}

/** An account where nothing this config names exists yet, but the Mac's origin does. */
const fresh = (): Account => ({
  apps: [],
  policies: [],
  tokens: [{ id: 'token-1', name: 'relay riverbend' }],
  scripts: [],
  routes: [],
  records: [
    {
      id: 'mac-rec',
      type: 'CNAME',
      name: MAC_ORIGIN,
      content: 'mac.cfargotunnel.com',
      proxied: true,
    },
  ],
  tunnels: [],
  certHosts: [ZONE, `*.${ZONE}`],
});

/** The same account once a first apply has made everything. */
const applied = (): Account => {
  const a = fresh();
  a.apps = [{ id: 'app-1', name: 'board riverbend', type: 'self_hosted', domain: RIVER_HOST }];
  a.policies = [
    { id: 'pol-people', name: 'riverbend people' },
    { id: 'pol-tokens', name: 'riverbend service tokens' },
  ];
  a.scripts = [{ id: 'board-router' }];
  a.routes = [{ id: 'route-1', pattern: `${RIVER_HOST}/*`, script: 'board-router' }];
  a.records.push(
    { id: 'rec-host', type: 'AAAA', name: RIVER_HOST, content: '100::', proxied: true },
    {
      id: 'rec-origin',
      type: 'CNAME',
      name: RIVER_ORIGIN,
      content: `${TUNNEL_ID}.cfargotunnel.com`,
      proxied: true,
    },
  );
  a.tunnels = [{ id: TUNNEL_ID, name: 'cw-riverbend', deleted_at: null, config_src: 'cloudflare' }];
  return a;
};

/** A read-only fake of the API: every write fails the test. */
function fakeApi(acct: Account): { api: CloudflareApi; writes: string[] } {
  const writes: string[] = [];
  const answer = (path: string): unknown => {
    const [p, q = ''] = path.split('?');
    const name = new URLSearchParams(q).get('name');
    if (p === '/zones') return name === ZONE ? [{ id: ZONE_ID, account: { id: ACCOUNT } }] : [];
    if (p === `/zones/${ZONE_ID}/ssl/certificate_packs`) return [{ hosts: acct.certHosts }];
    if (p === `/zones/${ZONE_ID}/dns_records`) return acct.records.filter((r) => r.name === name);
    if (p === `/zones/${ZONE_ID}/workers/routes`) return acct.routes;
    if (p === `/accounts/${ACCOUNT}/access/apps`) return acct.apps;
    if (p === `/accounts/${ACCOUNT}/access/policies`) return acct.policies;
    if (p === `/accounts/${ACCOUNT}/access/service_tokens`) return acct.tokens;
    if (p === `/accounts/${ACCOUNT}/workers/scripts`) return acct.scripts;
    if (p === `/accounts/${ACCOUNT}/cfd_tunnel`) return acct.tunnels.filter((t) => t.name === name);
    throw new Error(`unexpected read ${path}`);
  };
  const api = (async (method: string, path: string) => {
    if (method !== 'GET') {
      writes.push(`${method} ${path}`);
      throw new Error('discover must not write');
    }
    return answer(path);
  }) as CloudflareApi;
  api.all = async <T>(path: string) => answer(path) as T[];
  return { api, writes };
}

const refusalsOf = async (acct: Account, v = vars()) => {
  const r = await discover(fakeApi(acct).api, v, PROD);
  return r.ok ? [] : r.refusals;
};

describe('discover', () => {
  it('adopts nothing in a fresh account, and reads the ids terraform needs', async () => {
    const { api, writes } = fakeApi(fresh());
    const r = await discover(api, vars(), PROD);
    expect(r).toEqual({
      ok: true,
      vars: {
        account_id: ACCOUNT,
        zone_id: ZONE_ID,
        service_token_ids: { 'relay riverbend': 'token-1' },
        imports: {
          access_apps: {},
          access_people_policies: {},
          access_token_policies: {},
          scripts: {},
          routes: {},
          share_routes: {},
          dns_records: {},
          tunnels: {},
        },
      },
    });
    expect(writes).toEqual([]);
  });

  it('adopts every live resource the config names, so a plan creates no second copy', async () => {
    const r = await discover(fakeApi(applied()).api, vars(), PROD);
    expect(r.ok ? r.vars.imports : null).toEqual({
      access_apps: { riverbend: 'app-1' },
      access_people_policies: { riverbend: 'pol-people' },
      access_token_policies: { riverbend: 'pol-tokens' },
      scripts: { 'board-router': 'board-router' },
      routes: { riverbend: 'route-1' },
      share_routes: {},
      dns_records: { [RIVER_HOST]: 'rec-host', [RIVER_ORIGIN]: 'rec-origin' },
      tunnels: { riverbend: TUNNEL_ID },
    });
  });

  it('never adopts prod into staging, and refuses staging on prod’s hostnames', async () => {
    const staging: EnvNames = {
      name_prefix: 'staging ',
      router_script_name: 'board-router-staging',
      share_link_script_name: 'share-link-gate-staging',
    };
    const r = await discover(fakeApi(applied()).api, vars(), staging);
    expect(r.ok).toBe(false);
    const refusals = r.ok ? [] : r.refusals;
    expect(refusals).toContainEqual(
      expect.stringContaining('covered by the application "board riverbend"'),
    );
    expect(refusals).toContainEqual(
      expect.stringContaining('bound to the Worker board-router, not board-router-staging'),
    );
  });

  it('refuses a project host an application the config does not own covers', async () => {
    const acct = fresh();
    acct.apps = [{ id: 'prod', name: 'sign-in', type: 'self_hosted', domain: `*.${ZONE}` }];
    expect(await refusalsOf(acct)).toContainEqual(
      expect.stringContaining('covered by the application "sign-in"'),
    );
  });

  it("refuses an Access application over a tunnel's origin", async () => {
    const acct = fresh();
    acct.apps = [{ id: 'x', name: 'stray', destinations: [{ uri: `https://${RIVER_ORIGIN}/` }] }];
    expect(await refusalsOf(acct)).toContainEqual(
      expect.stringContaining(`covers ${RIVER_ORIGIN}`),
    );
  });

  it('CONTROL: an application over some other host refuses nothing', async () => {
    const acct = fresh();
    acct.apps = [{ id: 'x', name: 'share', type: 'self_hosted', domain: 'share.saltmarsh.test' }];
    expect(await refusalsOf(acct)).toEqual([]);
  });

  it('never repoints an origin record to a tunnel it was not made for', async () => {
    const acct = applied();
    const rec = acct.records.find((r) => r.name === RIVER_ORIGIN);
    if (rec) rec.content = 'mac.cfargotunnel.com';
    expect(await refusalsOf(acct)).toEqual([expect.stringContaining('must be a proxied CNAME')]);
    acct.tunnels = [];
    expect(await refusalsOf(acct)).toEqual([expect.stringContaining('the tunnel cw-riverbend')]);
  });

  it('refuses two tunnels of one name, and a tunnel configured from a file', async () => {
    const two = applied();
    two.tunnels.push({ ...two.tunnels[0], id: '22222222-2222-4333-8444-555555555555' });
    expect(await refusalsOf(two)).toContainEqual(expect.stringContaining('2 live tunnels'));
    const local = applied();
    local.tunnels = [{ id: TUNNEL_ID, name: 'cw-riverbend', config_src: 'local' }];
    expect(await refusalsOf(local)).toContainEqual(expect.stringContaining('from a file'));
  });

  it('refuses a route another Worker holds, and an unknown service token', async () => {
    const acct = fresh();
    acct.routes = [{ id: 'r', pattern: `${RIVER_HOST}/*`, script: 'someone-else' }];
    acct.tokens = [];
    expect(await refusalsOf(acct)).toEqual([
      'no service token is named "relay riverbend"',
      `the route ${RIVER_HOST}/* is bound to the Worker someone-else, not board-router`,
    ]);
  });

  it("refuses when the Mac's origin has no proxied record, or no certificate covers a host", async () => {
    const acct = fresh();
    acct.records = [];
    acct.certHosts = [ZONE, `workspaces.${ZONE}`];
    const got = await refusalsOf(acct);
    expect(got).toContainEqual(`origin ${MAC_ORIGIN} has no proxied DNS record`);
    expect(got).toContainEqual(expect.stringContaining(`no certificate covers ${RIVER_HOST}`));
  });

  it('refuses an application of the right name that is not self_hosted', async () => {
    const acct = fresh();
    acct.apps = [{ id: 'app-1', name: 'board riverbend', type: 'saas' }];
    expect(await refusalsOf(acct)).toEqual([expect.stringContaining('not self_hosted')]);
  });

  it('refuses a zone the token cannot see', async () => {
    expect(await refusalsOf(fresh(), vars({ zone: 'saltmarsh.test' }))).toEqual([
      'the token sees no zone named saltmarsh.test',
    ]);
  });
});
