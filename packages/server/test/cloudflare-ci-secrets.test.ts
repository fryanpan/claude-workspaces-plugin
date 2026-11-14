/**
 * `cf:ci-secrets` (infra/cloudflare/ci-secrets.ts): where each credential
 * goes, what runs in which mode, and what prints. A fake terraform and a fake
 * Cloudflare API; nothing leaves the process. What the Terraform root itself
 * makes is `infra/cloudflare/ci-secrets/tests/apply.tftest.hcl`.
 */
import { describe, expect, it } from 'bun:test';
import { type CiSecretsIo, USAGE, ciSecrets } from '../../../infra/cloudflare/ci-secrets.ts';
import { CONFIG_PATHS } from '../../../infra/cloudflare/vars.ts';
import type { CloudflareApi } from '../../../infra/project-machine/cloudflare.ts';

const CF_TOKEN = 'fixture-cf-token-Riverbend';
const GH_TOKEN = 'fixture-gh-token-Harborlight';
const FLY_TOKEN = 'fixture-fly-token-Saltmarsh';
const ACCOUNT = 'c'.repeat(32);

const SHOW = JSON.stringify({
  resource_changes: [
    { address: 'cloudflare_api_token.ci_deploy', change: { actions: ['create'] } },
    {
      address: 'github_actions_environment_secret.deploy["CLOUDFLARE_API_TOKEN"]',
      change: { actions: ['create'] },
    },
  ],
});

interface Run {
  io: CiSecretsIo;
  calls: Array<{ args: string[]; env: Record<string, string> }>;
  printed: () => string;
  removed: string[];
}

function fake(
  env: Record<string, string | undefined>,
  opts: { configs?: boolean; fail?: string; show?: string } = {},
): Run {
  const calls: Run['calls'] = [];
  const removed: string[] = [];
  let text = '';
  const configs: Record<string, string> = opts.configs
    ? {
        [CONFIG_PATHS.prod.router]: '{"zone":"harborlight.test"}',
        [CONFIG_PATHS.prod.access]: '{"projects":{}}',
        [CONFIG_PATHS.prod.shareLink]: 'name = "share-link-gate"',
      }
    : {};
  const api = (async (_m: string, path: string) => {
    if (path === '/accounts') return [{ id: ACCOUNT }];
    throw new Error(`unexpected ${path}`);
  }) as CloudflareApi;
  api.all = (async () => [{ id: ACCOUNT }]) as CloudflareApi['all'];
  const io: CiSecretsIo = {
    env,
    read: (rel) => configs[rel] ?? null,
    api: () => api,
    stateDir: '/fixture/state/ci-secrets',
    dataDir: '/fixture/state/ci-secrets-data',
    terraform: (args, e) => {
      calls.push({ args, env: e });
      if (args[0] === opts.fail) return { status: 1, stdout: '' };
      return {
        status: 0,
        stdout: args[0] === 'show' ? (opts.show ?? SHOW) : `terraform ${args[0]} said ${CF_TOKEN}`,
      };
    },
    removeFile: (p) => removed.push(p),
    out: (s) => {
      text += s;
    },
    err: (s) => {
      text += s;
    },
  };
  return { io, calls, printed: () => text, removed };
}

const BOTH = { CLOUDFLARE_API_TOKEN: CF_TOKEN, GITHUB_TOKEN: GH_TOKEN };

describe('cf:ci-secrets', () => {
  it('runs nothing without both tokens, and names the missing one', async () => {
    const r = fake({ CLOUDFLARE_API_TOKEN: CF_TOKEN });
    expect(await ciSecrets(['apply'], r.io)).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.printed()).toContain('GITHUB_TOKEN not set; nothing was run');
  });

  it('refuses an unknown mode', async () => {
    const r = fake(BOTH);
    expect(await ciSecrets(['destroy'], r.io)).toBe(2);
    expect(r.calls).toEqual([]);
  });

  it('plans without applying, and prints addresses, never a value', async () => {
    const r = fake({ ...BOTH, FLY_API_TOKEN: FLY_TOKEN }, { configs: true });
    expect(await ciSecrets(['plan'], r.io)).toBe(0);
    expect(r.calls.map((c) => c.args[0])).toEqual(['init', 'plan', 'show']);
    const out = r.printed();
    expect(out).toContain('`cloudflare_api_token.ci_deploy`');
    for (const secret of [CF_TOKEN, GH_TOKEN, FLY_TOKEN, ACCOUNT])
      expect(out).not.toContain(secret);
  });

  it('applies the saved plan it just made, then removes it', async () => {
    const r = fake(BOTH);
    expect(await ciSecrets(['apply'], r.io)).toBe(0);
    const plan = '/fixture/state/ci-secrets/ci-secrets.tfplan';
    expect(r.calls.map((c) => c.args)).toEqual([
      [
        'init',
        '-input=false',
        '-lockfile=readonly',
        '-reconfigure',
        '-backend-config=path=/fixture/state/ci-secrets/terraform.tfstate',
      ],
      ['plan', '-input=false', `-out=${plan}`],
      ['show', '-json', plan],
      ['apply', '-input=false', plan],
    ]);
    // Once before the plan (a killed run's leftover), once after.
    expect(r.removed).toEqual([plan, plan]);
  });

  it('hands every credential and config to terraform in its environment only', async () => {
    const r = fake({ ...BOTH, FLY_API_TOKEN: FLY_TOKEN }, { configs: true });
    await ciSecrets(['apply'], r.io);
    const env = r.calls[0]?.env ?? {};
    expect(env.CLOUDFLARE_API_TOKEN).toBe(CF_TOKEN);
    expect(env.GITHUB_TOKEN).toBe(GH_TOKEN);
    expect(env.TF_VAR_fly_api_token).toBe(FLY_TOKEN);
    expect(env.TF_VAR_account_id).toBe(ACCOUNT);
    expect(env.TF_VAR_router_config).toBe('{"zone":"harborlight.test"}');
    expect(env.TF_VAR_access_config).toBe('{"projects":{}}');
    expect(env.TF_VAR_share_link_config).toBe('name = "share-link-gate"');
    expect(env.TF_DATA_DIR).toBe('/fixture/state/ci-secrets-data');
    const args = r.calls.flatMap((c) => c.args).join(' ');
    for (const secret of [CF_TOKEN, GH_TOKEN, FLY_TOKEN, ACCOUNT])
      expect(args).not.toContain(secret);
  });

  it('leaves out a missing config and the Fly token rather than writing an empty secret', async () => {
    const r = fake(BOTH);
    await ciSecrets(['plan'], r.io);
    const env = r.calls[0]?.env ?? {};
    expect(Object.keys(env).filter((k) => /config|fly/.test(k))).toEqual([]);
    expect(r.printed()).toContain('apply refuses that without --drop');
  });

  it('stops at a failed plan without applying, and still removes the plan file', async () => {
    const r = fake(BOTH, { fail: 'plan' });
    expect(await ciSecrets(['apply'], r.io)).toBe(1);
    expect(r.calls.map((c) => c.args[0])).toEqual(['init', 'plan']);
    expect(r.removed).toHaveLength(2);
  });

  it('refuses an apply whose plan deletes a secret, and names it', async () => {
    const show = JSON.stringify({
      resource_changes: [
        {
          address: 'github_actions_environment_secret.deploy["FLY_API_TOKEN"]',
          change: { actions: ['delete'] },
        },
        { address: 'cloudflare_api_token.ci_deploy', change: { actions: ['no-op'] } },
      ],
    });
    const r = fake(BOTH, { show });
    expect(await ciSecrets(['apply'], r.io)).toBe(1);
    expect(r.calls.map((c) => c.args[0])).toEqual(['init', 'plan', 'show']);
    expect(r.printed()).toContain('github_actions_environment_secret.deploy["FLY_API_TOKEN"]');
    expect(r.printed()).toContain('nothing was applied');
  });

  it('refuses a replaced token the same way, and applies both with --drop', async () => {
    const show = JSON.stringify({
      resource_changes: [
        { address: 'cloudflare_api_token.ci_deploy', change: { actions: ['delete', 'create'] } },
      ],
    });
    const refused = fake(BOTH, { show });
    expect(await ciSecrets(['apply'], refused.io)).toBe(1);
    const dropped = fake(BOTH, { show });
    expect(await ciSecrets(['apply', '--drop'], dropped.io)).toBe(0);
    expect(dropped.calls.map((c) => c.args[0])).toContain('apply');
  });

  it('rejects an unknown flag', async () => {
    const r = fake(BOTH);
    expect(await ciSecrets(['apply', '--force'], r.io)).toBe(2);
    expect(r.printed()).toBe(USAGE);
  });
});
