/**
 * The pieces of the Terraform path that CI and `machine:deploy` lean on
 * (infra/cloudflare/credentials.ts, plan-summary.ts, outputs.ts): where each
 * credential comes from, what a public plan summary may say, and how the
 * outputs `machine:deploy` reads are checked. Fake sources and a fake
 * terraform; nothing reads the Keychain, the state bucket or Cloudflare.
 */
import { describe, expect, it } from 'bun:test';
import {
  backendConfig,
  stateCredentials,
  tfCredentials,
} from '../../../infra/cloudflare/credentials.ts';
import { type OutputIo, parseOutputs, readOutputs } from '../../../infra/cloudflare/outputs.ts';
import { planSummary, verbOf } from '../../../infra/cloudflare/plan-summary.ts';
import { parseEnvNames } from '../../../infra/cloudflare/vars.ts';

const ACCOUNT = 'b'.repeat(32);
const TOKEN = 'fixture-token-Saltmarsh-0000000000';
const R2 = { accessKeyId: 'fixture-r2-id', secretAccessKey: 'fixture-r2-secret-Saltmarsh' };

const keychain = (entries: Record<string, string>) => ({
  keychainHas: (n: string) => n in entries,
  keychainRead: (n: string) => entries[n] ?? '',
});

describe('credentials', () => {
  it('falls back to the Keychain entries when the environment has none', () => {
    const c = tfCredentials({
      env: {},
      ...keychain({
        'cloudflare-api-token': `${TOKEN}\n`,
        'cloudflare-r2-tfstate': JSON.stringify(R2),
      }),
    });
    expect(c.env).toEqual({
      CLOUDFLARE_API_TOKEN: TOKEN,
      AWS_ACCESS_KEY_ID: R2.accessKeyId,
      AWS_SECRET_ACCESS_KEY: R2.secretAccessKey,
    });
  });

  it('refuses a malformed state entry without quoting it', () => {
    const src = { env: {}, ...keychain({ 'cloudflare-r2-tfstate': 'not-json-Saltmarsh' }) };
    const error = (() => {
      try {
        stateCredentials(src);
      } catch (e) {
        return String(e);
      }
      return '';
    })();
    expect(error).toContain('is not JSON');
    expect(error).not.toContain('Saltmarsh');
  });

  it('writes one state key per environment at the account’s R2 endpoint', () => {
    expect(backendConfig('staging', ACCOUNT, 'cw-tfstate')).toBe(
      `bucket    = "cw-tfstate"\nkey       = "cloudflare/staging.tfstate"\nendpoints = { s3 = "https://${ACCOUNT}.r2.cloudflarestorage.com" }\n`,
    );
    expect(() => backendConfig('prod', 'not-an-account', 'cw-tfstate')).toThrow('32 hex');
    expect(() => backendConfig('prod', ACCOUNT, 'x" ; evil = "1')).toThrow('bucket name');
  });
});

describe("a deployment's terraform.tfvars", () => {
  it('reads the three names, skipping comments and blank lines', () => {
    const raw =
      '# names\n\nname_prefix = "staging "\nrouter_script_name = "board-router-staging"\nshare_link_script_name = "share-link-gate-staging"\n';
    expect(parseEnvNames(raw)).toEqual({
      name_prefix: 'staging ',
      router_script_name: 'board-router-staging',
      share_link_script_name: 'share-link-gate-staging',
    });
  });

  it('refuses a line it does not understand, and a missing name', () => {
    expect(() => parseEnvNames('name_prefix = ""\nrouter_script_name = var.x\n')).toThrow(
      'not key = "value"',
    );
    expect(() => parseEnvNames('name_prefix = ""\nrouter_script_name = "r"\n')).toThrow(
      'no share_link_script_name',
    );
  });
});

describe('planSummary', () => {
  const rc = (address: string, actions: string[], extra: Record<string, unknown> = {}) => ({
    address,
    mode: 'managed',
    change: { actions, after: { secret: 'value-Saltmarsh' }, ...extra },
  });

  it('names each change by address and verb, and no value', () => {
    const shown = JSON.stringify({
      resource_changes: [
        rc('a.x', ['update'], { importing: { id: '1' } }),
        rc('b.y', ['create']),
        rc('c.z', ['delete', 'create']),
        rc('d.w', ['delete']),
        rc('e.v', ['no-op']),
        { address: 'data.f', mode: 'data', change: { actions: ['read'] } },
      ],
    });
    const s = planSummary(shown, 'prod');
    expect(s).toBe(
      [
        'Cloudflare plan for prod: 1 to import, 1 to add, 0 to change, 1 to replace, 1 to destroy.',
        '',
        '- add `b.y`',
        '- destroy `d.w`',
        '- import and change `a.x`',
        '- replace `c.z`',
        '',
      ].join('\n'),
    );
    expect(s).not.toContain('Saltmarsh');
  });

  it('says so when nothing changes', () => {
    expect(
      planSummary(JSON.stringify({ resource_changes: [rc('e.v', ['no-op'])] }), 'staging'),
    ).toContain('No changes.');
    expect(verbOf(rc('e.v', ['update']))).toBe('change');
  });
});

const OUTPUT = {
  access: {
    value: { riverbend: { aud: 'aud-r', hosts: ['riverbend-workspaces.harborlight.test'] } },
  },
  access_team_domain: { value: 'harborlight.cloudflareaccess.com' },
  tunnels: {
    value: {
      riverbend: {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'cw-riverbend',
        origin: 'riverbend-origin.harborlight.test',
        public_host: 'riverbend-workspaces.harborlight.test',
      },
      saltmarsh: { id: 7 },
    },
  },
  tunnel_tokens: { value: { riverbend: `tok${'x'.repeat(40)}`, saltmarsh: null } },
};

describe('the outputs machine:deploy reads', () => {
  it('keeps only well-formed entries', () => {
    const o = parseOutputs(JSON.stringify(OUTPUT));
    expect(Object.keys(o.tunnels)).toEqual(['riverbend']);
    expect(Object.keys(o.tunnelTokens)).toEqual(['riverbend']);
    expect(o.access.riverbend?.aud).toBe('aud-r');
    expect(o.accessTeamDomain).toBe('harborlight.cloudflareaccess.com');
    expect(parseOutputs('{}')).toEqual({
      access: {},
      accessTeamDomain: null,
      tunnels: {},
      tunnelTokens: {},
    });
  });

  function io(over: Partial<OutputIo> = {}) {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const written: Record<string, string> = {};
    const o: OutputIo = {
      env: {
        AWS_ACCESS_KEY_ID: R2.accessKeyId,
        AWS_SECRET_ACCESS_KEY: R2.secretAccessKey,
        CLOUDFLARE_API_TOKEN: TOKEN,
      },
      ...keychain({}),
      backendExists: () => false,
      writeBackend: (p, c) => {
        written[p] = c;
      },
      terraform: (args, env) => {
        calls.push({ args, env });
        return { status: 0, stdout: args[0] === 'output' ? JSON.stringify(OUTPUT) : '' };
      },
      ...over,
    };
    return { o, calls, written };
  }

  it('reads them with the state credential only, building the backend from CLOUDFLARE_ACCOUNT_ID', () => {
    const { o, calls, written } = io();
    o.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
    expect(Object.keys(readOutputs('prod', o).tunnels)).toEqual(['riverbend']);
    expect(calls.map((c) => c.args[0])).toEqual(['init', 'output']);
    for (const c of calls) {
      expect(c.env).toEqual({
        AWS_ACCESS_KEY_ID: R2.accessKeyId,
        AWS_SECRET_ACCESS_KEY: R2.secretAccessKey,
      });
    }
    expect(Object.values(written).join()).toContain('cloudflare/prod.tfstate');
  });

  it('refuses, saying what to run, with no backend file and no account id', () => {
    const { o, calls } = io();
    expect(() => readOutputs('prod', o)).toThrow('bun run cf:plan prod');
    expect(calls).toEqual([]);
  });
});
