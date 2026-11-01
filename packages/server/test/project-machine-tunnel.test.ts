/**
 * The named tunnel as `machine:deploy` reads it (`infra/project-machine/tunnel-plan.ts`):
 * how it takes the tunnel Terraform made out of the outputs, reads its token
 * from the API, and the machine plan for a named tunnel. Which tunnels and records
 * exist is the Terraform config's (`infra/cloudflare/deploys/prod/tests`) and
 * `cloudflare-tf-discover.test.ts`'s. Nothing here calls Cloudflare or Fly.
 */
import { describe, expect, it } from 'bun:test';
import type { TfOutputs } from '../../../infra/cloudflare/outputs.ts';
import { unwrap } from '../../../infra/project-machine/cloudflare.ts';
import {
  plan,
  projectConfig,
  requiredSecrets,
} from '../../../infra/project-machine/deploy-plan.ts';
import {
  appliedTunnel,
  parseTunnelToken,
  readTunnelToken,
} from '../../../infra/project-machine/tunnel-plan.ts';

const SHA = 'a'.repeat(40);
const cfg = projectConfig({ project: 'riverbend', imageLabel: SHA, tunnel: 'named' });
const TUNNEL_ID = '11111111-2222-4333-8444-555555555555';
const ACCOUNT = 'a'.repeat(32);
const TUNNEL_TOKEN = `fixture${'t'.repeat(40)}`;

/** The outputs after Terraform made Riverbend's tunnel. */
const outputs = (over: Partial<TfOutputs['tunnels'][string]> | null = {}): TfOutputs => ({
  access: {},
  accessTeamDomain: null,
  tunnels:
    over === null
      ? {}
      : {
          riverbend: {
            account_id: ACCOUNT,
            id: TUNNEL_ID,
            name: 'cw-riverbend',
            origin: 'riverbend-origin.harborlight.test',
            public_host: 'riverbend-workspaces.harborlight.test',
            ...over,
          },
        },
});

describe('the tunnel Terraform made', () => {
  it('is read from the outputs by project, with its account', () => {
    const t = appliedTunnel(outputs(), cfg);
    expect([t.accountId, t.id, t.name, t.origin, t.publicHost]).toEqual([
      ACCOUNT,
      TUNNEL_ID,
      'cw-riverbend',
      'riverbend-origin.harborlight.test',
      'riverbend-workspaces.harborlight.test',
    ]);
  });

  it('is refused, naming the origin to give it, when the state has none', () => {
    expect(() => appliedTunnel(outputs(null), cfg)).toThrow('riverbend-origin.<zone>');
    expect(() => appliedTunnel(outputs(null), cfg)).toThrow('bun run cf:apply');
  });

  it('is refused when the state names a different tunnel or origin', () => {
    expect(() => appliedTunnel(outputs({ name: 'cw-saltmarsh' }), cfg)).toThrow(
      'is not cw-riverbend',
    );
    expect(() => appliedTunnel(outputs({ origin: 'mac-origin.harborlight.test' }), cfg)).toThrow(
      'cf:plan',
    );
  });

  it('is refused while its id is still unknown', () => {
    expect(() => appliedTunnel(outputs({ id: '' }), cfg)).toThrow('has no id yet');
  });

  it('is refused when the state names no account', () => {
    expect(() => appliedTunnel(outputs({ account_id: '' }), cfg)).toThrow('names no account');
  });

  it("has its token read from the API by the state's ids, never from the state", async () => {
    const calls: string[] = [];
    const api = Object.assign(
      async <T>(method: string, path: string): Promise<T> => {
        calls.push(`${method} ${path}`);
        return TUNNEL_TOKEN as T;
      },
      { all: async <T>(): Promise<T[]> => [] },
    );
    expect(await readTunnelToken(api, appliedTunnel(outputs(), cfg))).toBe(TUNNEL_TOKEN);
    expect(calls).toEqual([`GET /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL_ID}/token`]);
  });
});

describe('reading answers', () => {
  it('takes the token only as one long word', () => {
    const token = `fixture${'x'.repeat(40)}`;
    expect(parseTunnelToken(token)).toBe(token);
    for (const bad of [null, '', { token }, 'short', `${token} ${token}`]) {
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

  it('sets the token again, and redeploys, when asked to after Terraform remade the tunnel', () => {
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
