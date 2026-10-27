/**
 * The named tunnel's decisions (`infra/project-machine/tunnel-plan.ts`):
 * the names it derives, which Cloudflare steps a run plans for each state,
 * the bodies it sends and how it reads Cloudflare's answers. The answers
 * below have the shape Cloudflare's API documents for each endpoint, with
 * invented ids. Nothing here calls Cloudflare or Fly.
 */
import { describe, expect, it } from 'bun:test';
import { unwrap } from '../../../infra/project-machine/cloudflare.ts';
import {
  plan,
  projectConfig,
  requiredSecrets,
} from '../../../infra/project-machine/deploy-plan.ts';
import {
  type TunnelObserved,
  coversHost,
  desiredIngress,
  originRecord,
  parseAccessApps,
  parseIngress,
  parseTunnelToken,
  parseTunnels,
  planTunnel,
  tunnelConfigBody,
  tunnelCreateBody,
  tunnelNames,
} from '../../../infra/project-machine/tunnel-plan.ts';

const SHA = 'a'.repeat(40);
const cfg = projectConfig({ project: 'riverbend', imageLabel: SHA, tunnel: 'named' });
const ZONE = 'harborlight.test';
const names = tunnelNames(cfg, { zone: ZONE, oneAddress: `board.${ZONE}` });
const TUNNEL_ID = '11111111-2222-4333-8444-555555555555';
const TARGET = `${TUNNEL_ID}.cfargotunnel.com`;

/** `GET accounts/<id>/cfd_tunnel?name=…` result, one entry. */
const tunnelListAnswer = [
  {
    id: TUNNEL_ID,
    account_tag: '0'.repeat(32),
    created_at: '2026-10-27T18:22:34.317854Z',
    deleted_at: null,
    name: 'cw-riverbend',
    connections: [],
    conns_active_at: null,
    conns_inactive_at: '2026-10-27T18:22:34.317854Z',
    metadata: {},
    remote_config: true,
    status: 'inactive',
    tun_type: 'cfd_tunnel',
    config_src: 'cloudflare',
  },
];

/** `GET cfd_tunnel/<id>/configurations` result once the deploy has set it. */
const configAnswer = {
  account_id: '0'.repeat(32),
  tunnel_id: TUNNEL_ID,
  version: 1,
  source: 'cloudflare',
  created_at: '2026-10-27T18:25:00Z',
  config: {
    ingress: [
      {
        hostname: 'riverbend.board.harborlight.test',
        service: 'http://localhost:8787',
        originRequest: {},
      },
      { service: 'http_status:404' },
    ],
    'warp-routing': { enabled: false },
  },
};

const cname = { id: 'r1', type: 'CNAME', name: names.origin, content: TARGET, proxied: true };

function finished(): TunnelObserved {
  return {
    tunnels: parseTunnels(tunnelListAnswer),
    ingress: parseIngress(configAnswer),
    originRecords: [cname],
    accessApps: [],
  };
}

const empty: TunnelObserved = { tunnels: [], ingress: null, originRecords: [], accessApps: [] };

describe('tunnel names', () => {
  it('names the tunnel after the app, and the origin after the project in the zone', () => {
    expect(names).toEqual({
      zone: ZONE,
      tunnel: 'cw-riverbend',
      origin: 'riverbend-origin.harborlight.test',
      publicHost: 'riverbend.board.harborlight.test',
    });
  });
});

describe('planTunnel', () => {
  it('does every step for a project with nothing in Cloudflare', () => {
    expect(planTunnel(names, empty)).toEqual({
      ok: true,
      actions: [
        { kind: 'create-tunnel' },
        { kind: 'set-tunnel-config' },
        { kind: 'create-origin-record' },
      ],
    });
  });

  it('does nothing for a tunnel that is complete, and names its id', () => {
    expect(planTunnel(names, finished())).toEqual({ ok: true, actions: [], tunnelId: TUNNEL_ID });
  });

  it('sets the ingress of a tunnel that has none, or the wrong one', () => {
    const none = planTunnel(names, { ...finished(), ingress: null });
    expect(none).toEqual({
      ok: true,
      actions: [{ kind: 'set-tunnel-config' }],
      tunnelId: TUNNEL_ID,
    });
    const wrong = parseIngress({
      config: { ingress: [{ service: 'http://localhost:8787' }, { service: 'http_status:404' }] },
    });
    expect(planTunnel(names, { ...finished(), ingress: wrong })).toMatchObject({
      actions: [{ kind: 'set-tunnel-config' }],
    });
  });

  it('creates the origin record for an existing tunnel that has none', () => {
    expect(planTunnel(names, { ...finished(), originRecords: [] })).toEqual({
      ok: true,
      actions: [{ kind: 'create-origin-record' }],
      tunnelId: TUNNEL_ID,
    });
  });

  it('never repoints a record it did not make', () => {
    const cases = [
      { ...cname, content: 'ffffffff-2222-4333-8444-555555555555.cfargotunnel.com' },
      { ...cname, proxied: false },
      { id: 'r2', type: 'A', name: names.origin, content: '192.0.2.1', proxied: true },
    ];
    for (const r of cases) {
      const p = planTunnel(names, { ...finished(), originRecords: [r] });
      expect(p.ok).toBe(false);
    }
    // With no tunnel yet, any record at the origin is someone else's.
    expect(planTunnel(names, { ...empty, originRecords: [cname] }).ok).toBe(false);
  });

  it('stops on two tunnels of the name, or one configured from a file', () => {
    const two = parseTunnels([...tunnelListAnswer, { ...tunnelListAnswer[0], id: 'other' }]);
    expect(planTunnel(names, { ...finished(), tunnels: two })).toMatchObject({ ok: false });
    const local = parseTunnels([
      { ...tunnelListAnswer[0], remote_config: false, config_src: 'local' },
    ]);
    const p = planTunnel(names, { ...finished(), tunnels: local });
    expect(p.ok === false && p.problems.join()).toContain('reads its ingress from a file');
  });

  it('stops when an Access application covers the origin hostname', () => {
    const apps = parseAccessApps([
      {
        id: 'a1',
        name: 'Riverbend board',
        domain: 'riverbend.board.harborlight.test',
        type: 'self_hosted',
      },
      { id: 'a2', name: 'Whole zone', domain: '*.harborlight.test/', type: 'self_hosted' },
    ]);
    const p = planTunnel(names, { ...finished(), accessApps: apps });
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.problems).toEqual([expect.stringContaining('"Whole zone"')]);
  });
});

describe("reading Cloudflare's answers", () => {
  it('ignores a deleted tunnel in the list', () => {
    const gone = { ...tunnelListAnswer[0], deleted_at: '2026-10-27T19:00:00Z' };
    expect(parseTunnels([gone])).toEqual([]);
    expect(parseTunnels(tunnelListAnswer)).toEqual([
      { id: TUNNEL_ID, name: 'cw-riverbend', remoteConfig: true },
    ]);
  });

  it('reads the ingress without the fields the plan does not compare', () => {
    expect(parseIngress(configAnswer)).toEqual(desiredIngress(names));
    expect(parseIngress({ tunnel_id: TUNNEL_ID, version: 0, config: null })).toBeNull();
  });

  it('takes the token as the bare string Cloudflare answers with', () => {
    const token = `fixture${'x'.repeat(40)}`;
    expect(parseTunnelToken(token)).toBe(token);
    for (const bad of [null, '', { token }, 'short']) {
      expect(() => parseTunnelToken(bad)).toThrow('without a token');
    }
  });

  it('reads every hostname an Access application covers, from all three fields', () => {
    const [app] = parseAccessApps([
      {
        name: 'Riverbend board',
        domain: 'riverbend.board.harborlight.test/workspaces',
        self_hosted_domains: ['riverbend.board.harborlight.test', 'saltmarsh.harborlight.test'],
        destinations: [{ type: 'public', uri: 'https://riverbend-origin.harborlight.test/' }],
      },
    ]);
    expect(app?.hosts).toEqual([
      'riverbend.board.harborlight.test',
      'saltmarsh.harborlight.test',
      'riverbend-origin.harborlight.test',
    ]);
  });

  it('matches a wildcard Access hostname against subdomains only', () => {
    expect(coversHost('*.harborlight.test', names.origin)).toBe(true);
    expect(coversHost('*.harborlight.test', 'harborlight.test')).toBe(false);
    expect(coversHost('*.board.harborlight.test', names.origin)).toBe(false);
    expect(coversHost('Riverbend-Origin.harborlight.test', names.origin)).toBe(true);
  });

  it('names the failure from the error envelope, never the result', () => {
    const json = {
      success: false,
      errors: [{ code: 10000, message: 'Authentication error' }],
      result: null,
    };
    expect(() => unwrap('GET', '/accounts/x/cfd_tunnel?name=cw-riverbend', 403, json)).toThrow(
      'GET /accounts/x/cfd_tunnel failed (403): 10000 Authentication error',
    );
    expect(unwrap('GET', '/x', 200, { success: true, result: 'ok' })).toBe('ok');
    expect(() => unwrap('GET', '/x', 502, null, 'Bad Gateway')).toThrow('(502): Bad Gateway');
  });
});

describe('what goes to Cloudflare', () => {
  it('creates a tunnel Cloudflare configures', () => {
    expect(tunnelCreateBody(names)).toEqual({ name: 'cw-riverbend', config_src: 'cloudflare' });
  });

  it('sends one subdomain to the server and everything else to a 404', () => {
    expect(tunnelConfigBody(names)).toEqual({
      config: {
        ingress: [
          { hostname: 'riverbend.board.harborlight.test', service: 'http://localhost:8787' },
          { service: 'http_status:404' },
        ],
      },
    });
  });

  it('points the origin hostname at the tunnel, proxied', () => {
    expect(originRecord(names, TUNNEL_ID)).toMatchObject({
      type: 'CNAME',
      name: 'riverbend-origin.harborlight.test',
      content: TARGET,
      proxied: true,
    });
  });
});

describe('the machine plan for a named tunnel', () => {
  const done = {
    app: true,
    volumes: 1,
    keychain: new Set([cfg.keychain.identity, cfg.keychain.bucketAdmin, cfg.keychain.writer]),
    lifecycle: true,
    secrets: new Set(requiredSecrets('named')),
    machines: [{ id: 'm1', state: 'started', imageTag: SHA, memoryMb: 512 }],
  };

  it('does nothing when the token secret is set and the tunnel was not remade', () => {
    expect(plan(cfg, done)).toEqual([]);
  });

  it('sets the token again, and redeploys, when this run made a new tunnel', () => {
    expect(plan(cfg, done, ['CLOUDFLARE_TUNNEL_TOKEN'])).toEqual([
      { kind: 'set-secrets', names: ['CLOUDFLARE_TUNNEL_TOKEN'] },
      { kind: 'deploy' },
    ]);
  });

  it('removes the quick-tunnel switch from a machine moving to a named tunnel', () => {
    const fromQuick = { ...done, secrets: new Set([...done.secrets, 'CW_TUNNEL_MODE']) };
    expect(plan(cfg, fromQuick)).toEqual([
      { kind: 'unset-secrets', names: ['CW_TUNNEL_MODE'] },
      { kind: 'deploy' },
    ]);
  });
});
