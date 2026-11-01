/**
 * The named tunnel's names and readers (`infra/project-machine/tunnel-plan.ts`,
 * `tunnel.ts`): the names it derives, how `machine:deploy` reads the tunnel
 * `cf:apply` made out of the OpenTofu state, how it reads Cloudflare's token
 * answer, and the machine plan for a named tunnel. Which tunnels and records
 * exist is the OpenTofu config's (`infra/cloudflare/tests`) and
 * `cloudflare-tf-discover.test.ts`'s. Nothing here calls Cloudflare or Fly.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unwrap } from '../../../infra/project-machine/cloudflare.ts';
import {
  plan,
  projectConfig,
  requiredSecrets,
} from '../../../infra/project-machine/deploy-plan.ts';
import {
  appliedTunnel,
  parseTunnelToken,
  tunnelNames,
} from '../../../infra/project-machine/tunnel-plan.ts';
import { namedTunnel } from '../../../infra/project-machine/tunnel.ts';

const SHA = 'a'.repeat(40);
const cfg = projectConfig({ project: 'riverbend', imageLabel: SHA, tunnel: 'named' });
const ZONE = 'harborlight.test';
const names = tunnelNames(cfg, { zone: ZONE, oneAddress: `workspaces.${ZONE}` });
const TUNNEL_ID = '11111111-2222-4333-8444-555555555555';
const ACCOUNT = '0'.repeat(32);

/** `tofu output -json tunnels` after cf:apply made Riverbend's tunnel. */
const applied = {
  riverbend: {
    id: TUNNEL_ID,
    account_id: ACCOUNT,
    name: 'cw-riverbend',
    origin: 'riverbend-origin.harborlight.test',
    public_host: 'riverbend-workspaces.harborlight.test',
  },
};

describe('tunnel names', () => {
  it('names the tunnel after the app, and the origin after the project in the zone', () => {
    expect(names).toEqual({
      zone: ZONE,
      tunnel: 'cw-riverbend',
      origin: 'riverbend-origin.harborlight.test',
      publicHost: 'riverbend-workspaces.harborlight.test',
    });
  });

  it('puts the public host one level under the zone, apart from the origin', () => {
    // One level is what the zone's Universal SSL certificate covers.
    expect(names.publicHost.slice(names.publicHost.indexOf('.') + 1)).toBe(ZONE);
    expect(names.publicHost).not.toBe(names.origin);
  });
});

describe('the tunnel cf:apply made', () => {
  it('is read from the OpenTofu output by project', () => {
    expect(appliedTunnel(applied, 'riverbend', names)).toEqual({
      id: TUNNEL_ID,
      accountId: ACCOUNT,
    });
  });

  it('is refused, naming the router entry to add, when the state has none', () => {
    expect(() => appliedTunnel({}, 'riverbend', names)).toThrow(
      '"riverbend": "riverbend-origin.harborlight.test"',
    );
    expect(() => appliedTunnel(null, 'riverbend', names)).toThrow('bun run cf:apply');
  });

  it('is refused when the state names a different tunnel or origin', () => {
    const other = { riverbend: { ...applied.riverbend, name: 'cw-saltmarsh' } };
    expect(() => appliedTunnel(other, 'riverbend', names)).toThrow('is not cw-riverbend');
    const moved = { riverbend: { ...applied.riverbend, origin: 'mac-origin.harborlight.test' } };
    expect(() => appliedTunnel(moved, 'riverbend', names)).toThrow('cf:plan');
  });

  it('is refused while its id is still unknown', () => {
    const planned = { riverbend: { ...applied.riverbend, id: null } };
    expect(() => appliedTunnel(planned, 'riverbend', names)).toThrow('has no id yet');
  });

  it("is what machine:deploy uses, with the router config's zone and one address", () => {
    const dir = mkdtempSync(join(tmpdir(), 'tunnel-test-'));
    const router = join(dir, 'router.local.json');
    writeFileSync(
      router,
      JSON.stringify({
        zone: ZONE,
        oneAddress: `workspaces.${ZONE}`,
        projects: { riverbend: names.origin },
      }),
    );
    const t = namedTunnel(cfg, router, () => applied);
    expect([t.id, t.names.origin, t.names.publicHost]).toEqual([
      TUNNEL_ID,
      'riverbend-origin.harborlight.test',
      'riverbend-workspaces.harborlight.test',
    ]);
  });
});

describe("reading Cloudflare's answers", () => {
  it('takes the token as the bare string Cloudflare answers with', () => {
    const token = `fixture${'x'.repeat(40)}`;
    expect(parseTunnelToken(token)).toBe(token);
    for (const bad of [null, '', { token }, 'short']) {
      expect(() => parseTunnelToken(bad)).toThrow('without a token');
    }
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

  it('sets the token again, and redeploys, when asked to after cf:apply remade the tunnel', () => {
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
