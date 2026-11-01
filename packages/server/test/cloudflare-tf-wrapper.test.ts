/**
 * `bun run cf:plan` / `cf:apply` (infra/cloudflare/run.ts, vars.ts, tofu.ts)
 * with fake config files, a fake Keychain, a fake account and a fake tofu:
 * which variables it assembles, where the token goes, and what it refuses
 * before tofu runs. Nothing here reads the Keychain or calls Cloudflare.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type WrapperIo, runWrapper } from '../../../infra/cloudflare/run.ts';
import { spawnTofu } from '../../../infra/cloudflare/tofu.ts';
import { CONFIG_PATHS, staticVars } from '../../../infra/cloudflare/vars.ts';
import type { CloudflareApi } from '../../../infra/project-machine/cloudflare.ts';

const ZONE = 'harborlight.test';
const ACCOUNT = 'a'.repeat(32);
const ZONE_ID = 'f'.repeat(32);
/** A stand-in token: what the test looks for anywhere it must not be. */
const TOKEN = 'fixture-token-Riverbend-0000000000';

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

const files =
  (over: Record<string, string | null> = {}) =>
  (rel: string): string | null => {
    const all: Record<string, string | null> = {
      [CONFIG_PATHS.router]: JSON.stringify(router),
      [CONFIG_PATHS.access]: JSON.stringify(access),
      [CONFIG_PATHS.shareLink]: null,
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
    expect(staticVars(files({ [CONFIG_PATHS.shareLink]: shareToml })).share_link_routes).toEqual([
      `share.${ZONE}/share/*`,
    ]);
  });

  it('refuses the committed placeholder routes, and a route in another zone', () => {
    const placeholder = shareToml.replace(`share.${ZONE}`, '<public-hostname>');
    expect(() => staticVars(files({ [CONFIG_PATHS.shareLink]: placeholder }))).toThrow(
      '<host>/share/*',
    );
    const elsewhere = shareToml.replaceAll(ZONE, 'saltmarsh.test');
    expect(() => staticVars(files({ [CONFIG_PATHS.shareLink]: elsewhere }))).toThrow(
      'outside router.local.json',
    );
  });

  it('needs router.local.json, and manages no Access application without access.local.json', () => {
    expect(() => staticVars(files({ [CONFIG_PATHS.router]: null }))).toThrow('missing');
    expect(staticVars(files({ [CONFIG_PATHS.access]: null })).access_projects).toEqual({});
  });

  it("refuses an Access application over a tunnel's origin", () => {
    const bad = { projects: { riverbend: { hosts: [`riverbend-origin.${ZONE}`] } } };
    expect(() => staticVars(files({ [CONFIG_PATHS.access]: JSON.stringify(bad) }))).toThrow(
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

interface Recorded {
  io: WrapperIo;
  tofuCalls: Array<{ args: string[]; env: Record<string, string> }>;
  vars: string[];
  out: string[];
  err: string[];
}

function fakeIo(over: Partial<WrapperIo> = {}): Recorded {
  const r: Recorded = { tofuCalls: [], vars: [], out: [], err: [], io: undefined as never };
  r.io = {
    read: files(),
    token: () => TOKEN,
    api: () => fakeApi(),
    writeVars: (json) => r.vars.push(json),
    tofu: (args, env) => {
      r.tofuCalls.push({ args, env });
      const isOutput = args[0] === 'output';
      return { status: 0, stdout: isOutput ? JSON.stringify({ riverbend: 'aud-riverbend' }) : '' };
    },
    out: (s) => r.out.push(s),
    err: (s) => r.err.push(s),
    ...over,
  };
  return r;
}

describe('runWrapper', () => {
  it('plans with the assembled variables, the token in tofu’s environment only', async () => {
    const r = fakeIo();
    expect(await runWrapper('plan', r.io)).toBe(0);
    expect(r.tofuCalls.map((c) => c.args[0])).toEqual(['init', 'plan']);
    for (const c of r.tofuCalls) {
      expect(c.env).toEqual({ CLOUDFLARE_API_TOKEN: TOKEN });
      expect(c.args.join(' ')).not.toContain(TOKEN);
    }
    const written = JSON.parse(r.vars[0] ?? '{}');
    expect(written.account_id).toBe(ACCOUNT);
    expect(written.zone_id).toBe(ZONE_ID);
    expect(Object.keys(written.tunnels)).toEqual(['riverbend']);
    expect(r.vars.join()).not.toContain(TOKEN);
    expect([...r.out, ...r.err].join()).not.toContain(TOKEN);
  });

  it('prints each server’s audience settings after an apply, never the token', async () => {
    const r = fakeIo();
    expect(await runWrapper('apply', r.io)).toBe(0);
    expect(r.tofuCalls.map((c) => c.args[0])).toEqual(['init', 'apply', 'output']);
    expect(r.tofuCalls[2]?.env).toEqual({});
    expect(r.out).toEqual([
      'riverbend: CF_ACCESS_AUD=aud-riverbend\n',
      `riverbend: CF_ACCESS_HOST_AUDS='{"riverbend-workspaces.${ZONE}":"aud-riverbend"}'\n`,
    ]);
  });

  it('runs no tofu and writes nothing when the Keychain has no token', async () => {
    const r = fakeIo({
      token: () => {
        throw new Error('the Keychain has no cloudflare-api-token; nothing was changed');
      },
    });
    expect(await runWrapper('apply', r.io)).toBe(1);
    expect(r.tofuCalls).toEqual([]);
    expect(r.vars).toEqual([]);
    expect(r.err.join()).toContain('cloudflare-api-token');
  });

  it('runs no tofu when the account holds something in the way', async () => {
    const r = fakeIo({
      read: files({
        [CONFIG_PATHS.router]: JSON.stringify({
          ...router,
          zone: 'saltmarsh.test',
          oneAddress: 'workspaces.saltmarsh.test',
          projects: {},
        }),
      }),
    });
    r.io.api = () => {
      const api = (async () => []) as unknown as CloudflareApi;
      api.all = async () => [];
      return api;
    };
    expect(await runWrapper('plan', r.io)).toBe(1);
    expect(r.tofuCalls).toEqual([]);
    expect(r.err.join()).toContain('no zone named saltmarsh.test');
  });

  it('stops when tofu init fails, before any plan', async () => {
    const r = fakeIo({ tofu: (args) => ({ status: args[0] === 'init' ? 1 : 0, stdout: '' }) });
    expect(await runWrapper('plan', r.io)).toBe(1);
    expect(r.err.join()).toContain('tofu init exited 1');
  });
});

describe('spawnTofu', () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it('runs tofu under umask 077 with the token in its environment, and locks the state down', () => {
    const bin = mkdtempSync(join(tmpdir(), 'fake-tofu-'));
    const state = mkdtempSync(join(tmpdir(), 'fake-state-'));
    const loose = join(state, 'terraform.tfstate');
    writeFileSync(loose, '{}', { mode: 0o644 });
    writeFileSync(
      join(bin, 'tofu'),
      '#!/bin/sh\nprintf "umask=%s args=%s token=%s" "$(umask)" "$*" "${CLOUDFLARE_API_TOKEN:+set}"\n',
    );
    chmodSync(join(bin, 'tofu'), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    const r = spawnTofu(['plan', '-input=false'], { CLOUDFLARE_API_TOKEN: TOKEN }, true, state);
    expect(r).toEqual({ status: 0, stdout: 'umask=0077 args=plan -input=false token=set' });
    expect(statSync(loose).mode & 0o777).toBe(0o600);
    expect(statSync(state).mode & 0o777).toBe(0o700);
    expect(readFileSync(loose, 'utf8')).toBe('{}');
  });
});
