/**
 * `bun run cf:plan` / `cf:apply` (infra/cloudflare/run.ts, vars.ts,
 * terraform.ts) with fake configs, a fake Keychain, a fake account and a fake
 * terraform: which variables it assembles, where each credential goes, what
 * CI prints, and what it refuses before terraform runs. Nothing here reads
 * the Keychain or calls Cloudflare.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type WrapperIo,
  type WrapperOptions,
  configReader,
  runWrapper,
} from '../../../infra/cloudflare/run.ts';
import { spawnTerraform } from '../../../infra/cloudflare/terraform.ts';
import { CONFIG_PATHS, staticVars } from '../../../infra/cloudflare/vars.ts';
import type { CloudflareApi } from '../../../infra/project-machine/cloudflare.ts';

const ZONE = 'harborlight.test';
const ACCOUNT = 'a'.repeat(32);
const ZONE_ID = 'f'.repeat(32);
/** Stand-in credentials: what the test looks for anywhere they must not be. */
const TOKEN = 'fixture-token-Riverbend-0000000000';
const R2_ID = 'fixture-r2-id-riverbend';
const R2_SECRET = 'fixture-r2-secret-Riverbend-0000';
const P = CONFIG_PATHS.prod;

const router = {
  zone: ZONE,
  oneAddress: `workspaces.${ZONE}`,
  projects: { riverbend: `riverbend-origin.${ZONE}`, saltmarsh: `mac-origin.${ZONE}` },
};
const access = {
  sessionDuration: '12h',
  projects: {
    riverbend: {
      hosts: [`riverbend-workspaces.${ZONE}`],
      emails: ['alice@harborlight.test'],
      emailDomains: ['riverbend.test'],
    },
  },
};
const shareToml = `name = "share-link-gate"
routes = [
  { pattern = "share.${ZONE}/share/*", zone_name = "${ZONE}" },
]
`;
const names = (env: string) =>
  [
    '# committed per deployment',
    `name_prefix            = "${env === 'prod' ? '' : 'staging '}"`,
    `router_script_name     = "${env === 'prod' ? 'board-router' : 'board-router-staging'}"`,
    'share_link_script_name = "share-link-gate"',
    '',
  ].join('\n');

const files =
  (over: Record<string, string | null> = {}) =>
  (rel: string): string | null => {
    const all: Record<string, string | null> = {
      [P.router]: JSON.stringify(router),
      [P.access]: JSON.stringify(access),
      [P.shareLink]: null,
      [CONFIG_PATHS.staging.router]: JSON.stringify(router),
      'infra/cloudflare/deploys/prod/terraform.tfvars': names('prod'),
      'infra/cloudflare/deploys/staging/terraform.tfvars': names('staging'),
      ...over,
    };
    return all[rel] ?? null;
  };

describe('staticVars', () => {
  it('makes a tunnel only for a project on a machine origin, and every project a hostname', () => {
    const v = staticVars(files());
    expect(v.project_hosts).toEqual({
      riverbend: `riverbend-workspaces.${ZONE}`,
      saltmarsh: `saltmarsh-workspaces.${ZONE}`,
    });
    expect(v.tunnels).toEqual({
      riverbend: {
        name: 'cw-riverbend',
        origin: `riverbend-origin.${ZONE}`,
        public_host: `riverbend-workspaces.${ZONE}`,
      },
    });
    expect(v.access_session_duration).toBe('12h');
    expect(v.access_projects.riverbend).toEqual({
      hosts: [`riverbend-workspaces.${ZONE}`],
      emails: ['alice@harborlight.test'],
      email_domains: ['riverbend.test'],
      service_tokens: [],
    });
    expect(v.share_link_routes).toEqual([]);
  });

  it('reads the share-link routes from wrangler.local.toml when it exists', () => {
    expect(staticVars(files({ [P.shareLink]: shareToml })).share_link_routes).toEqual([
      `share.${ZONE}/share/*`,
    ]);
  });

  it('refuses the committed placeholder routes, and a route in another zone', () => {
    const placeholder = shareToml.replace(`share.${ZONE}`, '<public-hostname>');
    expect(() => staticVars(files({ [P.shareLink]: placeholder }))).toThrow('<host>/share/*');
    const elsewhere = shareToml.replaceAll(ZONE, 'saltmarsh.test');
    expect(() => staticVars(files({ [P.shareLink]: elsewhere }))).toThrow(
      'outside router.local.json',
    );
  });

  it('needs router.local.json, and manages no Access application without access.local.json', () => {
    expect(() => staticVars(files({ [P.router]: null }))).toThrow('missing');
    expect(staticVars(files({ [P.access]: null })).access_projects).toEqual({});
  });

  it("refuses an Access application over a tunnel's origin", () => {
    const bad = { projects: { riverbend: { hosts: [`riverbend-origin.${ZONE}`] } } };
    expect(() => staticVars(files({ [P.access]: JSON.stringify(bad) }))).toThrow(
      "is a tunnel's origin",
    );
  });
});

/** An account holding the zone and nothing else this config names. */
function fakeApi(): CloudflareApi {
  const answer = (path: string): unknown => {
    const p = path.split('?')[0];
    if (p === '/zones') return [{ id: ZONE_ID, account: { id: ACCOUNT } }];
    if (p?.endsWith('/ssl/certificate_packs')) return [{ hosts: [ZONE, `*.${ZONE}`] }];
    if (p?.endsWith('/dns_records')) {
      return path.includes('mac-origin')
        ? [{ id: 'm', type: 'CNAME', name: `mac-origin.${ZONE}`, content: 'x', proxied: true }]
        : [];
    }
    return [];
  };
  const api = (async (_m: string, path: string) => answer(path)) as CloudflareApi;
  api.all = async <T>(path: string) => answer(path) as T[];
  return api;
}

/** `terraform show -json` of a plan that imports one application and adds one route. */
const SHOWN = JSON.stringify({
  resource_changes: [
    {
      address:
        'module.stack.module.access.cloudflare_zero_trust_access_application.project["riverbend"]',
      mode: 'managed',
      change: {
        actions: ['no-op'],
        importing: { id: 'x' },
        after: { domain: `riverbend-workspaces.${ZONE}` },
      },
    },
    {
      address: 'module.stack.module.router.cloudflare_workers_route.router["riverbend"]',
      mode: 'managed',
      change: { actions: ['create'], after: { pattern: `riverbend-workspaces.${ZONE}/*` } },
    },
  ],
});

interface Call {
  args: string[];
  env: Record<string, string>;
  capture: boolean;
}

interface Recorded {
  io: WrapperIo;
  calls: Call[];
  state: Record<string, string>;
  out: string[];
  err: string[];
}

const KEYCHAIN: Record<string, string> = {
  'cloudflare-api-token': TOKEN,
  'cloudflare-r2-tfstate': JSON.stringify({ accessKeyId: R2_ID, secretAccessKey: R2_SECRET }),
};

function fakeIo(over: Partial<WrapperIo> = {}): Recorded {
  const r: Recorded = { calls: [], state: {}, out: [], err: [], io: undefined as never };
  r.io = {
    read: files(),
    env: {},
    keychainHas: (n) => n in KEYCHAIN,
    keychainRead: (n) => KEYCHAIN[n] ?? '',
    api: () => fakeApi(),
    writeState: (name, content) => {
      r.state[name] = content;
      return `/state/${name}`;
    },
    statePath: (name) => `/state/${name}`,
    terraform: (args, env, capture = false) => {
      r.calls.push({ args, env, capture });
      if (args[0] === 'show') return { status: 0, stdout: SHOWN };
      if (args[0] === 'output') {
        const a = { riverbend: { aud: 'aud-riverbend', hosts: [`riverbend-workspaces.${ZONE}`] } };
        return { status: 0, stdout: JSON.stringify(a) };
      }
      return { status: 0, stdout: '' };
    },
    out: (s) => r.out.push(s),
    err: (s) => r.err.push(s),
    ...over,
  };
  return r;
}

const PROD: WrapperOptions = { env: 'prod', ci: false };
const CREDS = {
  CLOUDFLARE_API_TOKEN: TOKEN,
  AWS_ACCESS_KEY_ID: R2_ID,
  AWS_SECRET_ACCESS_KEY: R2_SECRET,
};

/** Every credential value, anywhere it must not appear. */
function leaks(r: Recorded): string[] {
  const where = [
    ...r.calls.map((c) => c.args.join(' ')),
    ...Object.values(r.state),
    ...r.out,
    ...r.err,
  ].join('\n');
  return [TOKEN, R2_ID, R2_SECRET].filter((v) => where.includes(v));
}

describe('runWrapper', () => {
  it('plans prod against its own state key, the credentials in terraform’s environment only', async () => {
    const r = fakeIo();
    expect(await runWrapper('plan', PROD, r.io)).toBe(0);
    expect(r.calls.map((c) => c.args[0])).toEqual(['init', 'plan']);
    for (const c of r.calls) expect(c.env).toEqual(CREDS);
    expect(r.calls[0]?.args).toContain('-backend-config=/state/backend.hcl');
    expect(r.state['backend.hcl']).toContain('key       = "cloudflare/prod.tfstate"');
    expect(r.state['backend.hcl']).toContain(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
    const written = JSON.parse(r.state['run.tfvars.json'] ?? '{}');
    expect(written.account_id).toBe(ACCOUNT);
    expect(written.zone_id).toBe(ZONE_ID);
    expect(Object.keys(written.tunnels)).toEqual(['riverbend']);
    expect(Object.keys(written.imports)).toContain('share_routes');
    expect(leaks(r)).toEqual([]);
  });

  it('plans staging from its own configs and key, and adopts nothing there', async () => {
    const r = fakeIo();
    expect(await runWrapper('plan', { env: 'staging', ci: false }, r.io)).toBe(0);
    expect(r.state['backend.hcl']).toContain('key       = "cloudflare/staging.tfstate"');
    expect(JSON.parse(r.state['run.tfvars.json'] ?? '{}').imports).toBeUndefined();
  });

  it('takes CI’s credentials from the environment and never asks the Keychain', async () => {
    const asked: string[] = [];
    const r = fakeIo({
      env: {
        CLOUDFLARE_API_TOKEN: TOKEN,
        AWS_ACCESS_KEY_ID: R2_ID,
        AWS_SECRET_ACCESS_KEY: R2_SECRET,
      },
      keychainHas: (n) => {
        asked.push(n);
        return false;
      },
    });
    expect(await runWrapper('plan', PROD, r.io)).toBe(0);
    expect(asked).toEqual([]);
    expect(r.calls[0]?.env).toEqual(CREDS);
  });

  it('in CI saves the plan, prints only its summary, and applies exactly that plan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-summary-'));
    const summaryFile = join(dir, 'summary.md');
    const r = fakeIo({ env: { CF_PLAN_SUMMARY: summaryFile } });
    expect(await runWrapper('apply', { env: 'prod', ci: true }, r.io)).toBe(0);
    expect(r.calls.map((c) => c.args[0])).toEqual(['init', 'plan', 'show', 'apply']);
    expect(r.calls.every((c) => c.capture)).toBe(true);
    expect(r.calls[1]?.args).toContain('-out=/state/plan.tfplan');
    expect(r.calls[3]?.args).toEqual(['apply', '-input=false', '/state/plan.tfplan']);
    const summary = readFileSync(summaryFile, 'utf8');
    expect(summary).toContain('1 to import, 1 to add, 0 to change, 0 to replace, 0 to destroy');
    expect(summary).toContain('cloudflare_workers_route.router["riverbend"]');
    // The summary is public in CI: it names addresses, never a hostname.
    expect([summary, ...r.out].join()).not.toContain(ZONE);
    expect(leaks(r)).toEqual([]);
  });

  it('prints each server’s audience settings after a local apply', async () => {
    const r = fakeIo();
    expect(await runWrapper('apply', PROD, r.io)).toBe(0);
    expect(r.calls.map((c) => c.args[0])).toEqual(['init', 'apply', 'output']);
    expect(r.out).toEqual([
      'riverbend: CF_ACCESS_AUD=aud-riverbend\n',
      `riverbend: CF_ACCESS_HOST_AUDS='{"riverbend-workspaces.${ZONE}":"aud-riverbend"}'\n`,
    ]);
  });

  it('runs no terraform and writes nothing when no token is set anywhere', async () => {
    const r = fakeIo({ keychainHas: () => false });
    expect(await runWrapper('apply', PROD, r.io)).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.state).toEqual({});
    expect(r.err.join()).toContain('CLOUDFLARE_API_TOKEN');
  });

  it('runs no terraform when the account holds something in the way', async () => {
    const other = {
      ...router,
      zone: 'saltmarsh.test',
      oneAddress: 'workspaces.saltmarsh.test',
      projects: {},
    };
    const r = fakeIo({ read: files({ [P.router]: JSON.stringify(other) }) });
    r.io.api = () => {
      const api = (async () => []) as unknown as CloudflareApi;
      api.all = async () => [];
      return api;
    };
    expect(await runWrapper('plan', PROD, r.io)).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.err.join()).toContain('no zone named saltmarsh.test');
  });

  it('stops when terraform init fails, before any plan', async () => {
    const r = fakeIo({ terraform: (args) => ({ status: args[0] === 'init' ? 1 : 0, stdout: '' }) });
    expect(await runWrapper('plan', PROD, r.io)).toBe(1);
    expect(r.err.join()).toContain('terraform init exited 1');
  });
});

describe('configReader', () => {
  it('takes a config from its CI stand-in before its file', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cf-repo-'));
    const read = configReader({ CF_ACCESS_CONFIG: '{"from":"env"}' }, repo);
    expect(read(P.access)).toBe('{"from":"env"}');
    expect(read(P.router)).toBeNull();
  });
});

describe('spawnTerraform', () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it('runs terraform under umask 077 with the token in its environment, and locks the state down', () => {
    const bin = mkdtempSync(join(tmpdir(), 'fake-terraform-'));
    const state = mkdtempSync(join(tmpdir(), 'fake-state-'));
    const loose = join(state, 'run.tfvars.json');
    writeFileSync(loose, '{}', { mode: 0o644 });
    writeFileSync(
      join(bin, 'terraform'),
      '#!/bin/sh\nprintf "umask=%s args=%s token=%s" "$(umask)" "$*" "${CLOUDFLARE_API_TOKEN:+set}"\n',
    );
    chmodSync(join(bin, 'terraform'), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    const r = spawnTerraform(
      state,
      ['plan', '-input=false'],
      { CLOUDFLARE_API_TOKEN: TOKEN },
      true,
      state,
    );
    expect(r).toEqual({ status: 0, stdout: 'umask=0077 args=plan -input=false token=set' });
    expect(statSync(loose).mode & 0o777).toBe(0o600);
    expect(statSync(state).mode & 0o777).toBe(0o700);
    expect(readFileSync(loose, 'utf8')).toBe('{}');
  });
});
