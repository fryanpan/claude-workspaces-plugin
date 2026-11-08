/**
 * Access service tokens under Terraform (`infra/cloudflare/service-tokens.ts`,
 * through `run.ts`): a token the config names and the account lacks is shown
 * by a plan, made by a local apply with its pair put straight into the
 * Keychain, refused by a CI apply, and never printed, written to the state
 * directory or passed as an argument. A fake account, a fake Keychain and a
 * fake terraform; nothing here calls Cloudflare or reads the real Keychain.
 */
import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type WrapperIo, runWrapper } from '../../../infra/cloudflare/run.ts';
import {
  type TokenServices,
  keychainAdd,
  tokenServices,
} from '../../../infra/cloudflare/service-tokens.ts';
import { CONFIG_PATHS } from '../../../infra/cloudflare/vars.ts';
import type { CloudflareApi } from '../../../infra/project-machine/cloudflare.ts';

const ZONE = 'harborlight.test';
const ACCOUNT = 'a'.repeat(32);
const ZONE_ID = 'f'.repeat(32);
const TOKEN = 'fixture-token-Riverbend-0000000000';
/** What Cloudflare answers the create with: the only time it sends the secret. */
const NEW_ID = '33333333-2222-4333-8444-555555555555';
const NEW_CLIENT_ID = 'c0ffee0000000000riverbend.access';
const NEW_SECRET = 'feedface'.repeat(8);
const P = CONFIG_PATHS.prod;

const files = (tokens: string[]) => (rel: string) => {
  const all: Record<string, string> = {
    [P.router]: JSON.stringify({
      zone: ZONE,
      oneAddress: `workspaces.${ZONE}`,
      projects: { riverbend: `mac-origin.${ZONE}` },
    }),
    [P.access]: JSON.stringify({
      projects: {
        riverbend: { hosts: [`riverbend-workspaces.${ZONE}`], serviceTokens: tokens },
      },
    }),
    'infra/cloudflare/deploys/prod/terraform.tfvars':
      'name_prefix = ""\nrouter_script_name = "board-router"\nshare_link_script_name = "share-link-gate"\n',
  };
  return all[rel] ?? null;
};

interface World {
  io: WrapperIo;
  posts: Array<{ path: string; body: unknown }>;
  stored: Array<{ services: TokenServices; clientId: string; secret: string }>;
  asked: string[];
  tf: string[][];
  state: Record<string, string>;
  out: string[];
  err: string[];
}

function world(opts: {
  tokens: string[];
  existing?: Array<{ id: string; name: string }>;
  confirm?: boolean;
  taken?: string[];
  storeFails?: boolean;
}): World {
  const w: World = {
    posts: [],
    stored: [],
    asked: [],
    tf: [],
    state: {},
    out: [],
    err: [],
    io: undefined as never,
  };
  const answer = (path: string): unknown => {
    const p = path.split('?')[0] ?? '';
    if (p === '/zones') return [{ id: ZONE_ID, account: { id: ACCOUNT } }];
    if (p.endsWith('/ssl/certificate_packs')) return [{ hosts: [ZONE, `*.${ZONE}`] }];
    if (p.endsWith('/dns_records')) {
      return [{ id: 'm', type: 'CNAME', name: `mac-origin.${ZONE}`, content: 'x', proxied: true }];
    }
    if (p === `/accounts/${ACCOUNT}/access/service_tokens`) return opts.existing ?? [];
    return [];
  };
  const api = (async (method: string, path: string, body?: unknown) => {
    if (method === 'POST' && path === `/accounts/${ACCOUNT}/access/service_tokens`) {
      w.posts.push({ path, body });
      return {
        id: NEW_ID,
        name: (body as { name: string }).name,
        client_id: NEW_CLIENT_ID,
        client_secret: NEW_SECRET,
      };
    }
    if (method !== 'GET') throw new Error(`unexpected ${method} ${path}`);
    return answer(path);
  }) as CloudflareApi;
  api.all = async <T>(path: string) => answer(path) as T[];
  w.io = {
    read: files(opts.tokens),
    env: {},
    keychainHas: (n) => n === 'cloudflare-api-token' || n === 'cloudflare-r2-tfstate',
    keychainRead: (n) =>
      n === 'cloudflare-api-token'
        ? TOKEN
        : JSON.stringify({ accessKeyId: 'k', secretAccessKey: 's' }),
    keychainHasService: (s) => (opts.taken ?? []).includes(s),
    storeToken: (services, clientId, secret) => {
      if (opts.storeFails) throw new Error(`refused to store ${secret}`);
      w.stored.push({ services, clientId, secret });
    },
    confirm: (q) => {
      w.asked.push(q);
      return opts.confirm ?? true;
    },
    api: () => api,
    writeState: (name, content) => {
      w.state[name] = content;
      return `/state/${name}`;
    },
    statePath: (name) => `/state/${name}`,
    terraform: (args) => {
      w.tf.push(args);
      return { status: 0, stdout: args[0] === 'show' ? '{"resource_changes":[]}' : '{}' };
    },
    out: (s) => w.out.push(s),
    err: (s) => w.err.push(s),
  };
  return w;
}

/** The new pair, anywhere it must not be. */
const leaked = (w: World) =>
  [NEW_SECRET].filter((v) =>
    [...w.tf.map((a) => a.join(' ')), ...Object.values(w.state), ...w.out, ...w.err]
      .join('\n')
      .includes(v),
  );

const tfvars = (w: World) => JSON.parse(w.state['run.tfvars.json'] ?? '{}');

describe('service tokens in cf:plan and cf:apply', () => {
  it('a plan shows the missing token instead of refusing, and makes nothing', async () => {
    const w = world({ tokens: ['agent moi'] });
    expect(await runWrapper('plan', { env: 'prod', ci: false }, w.io)).toBe(0);
    expect(w.tf.map((a) => a[0])).toEqual(['init', 'plan']);
    expect(w.posts).toEqual([]);
    expect(w.asked).toEqual([]);
    expect(tfvars(w).service_token_ids).toEqual({});
    expect(w.out.join('')).toContain('"agent moi" does not exist: cf:apply makes it');
    expect(w.out.join('')).toContain('cw-agent-moi-access-secret');
  });

  it('a local apply makes the token, keeps its pair in the Keychain, and imports it by id', async () => {
    const w = world({ tokens: ['agent moi'] });
    expect(await runWrapper('apply', { env: 'prod', ci: false }, w.io)).toBe(0);
    expect(w.asked).toHaveLength(1);
    expect(w.posts).toEqual([
      { path: `/accounts/${ACCOUNT}/access/service_tokens`, body: { name: 'agent moi' } },
    ]);
    expect(w.stored).toEqual([
      {
        services: {
          clientId: 'cw-agent-moi-access-client-id',
          secret: 'cw-agent-moi-access-secret',
        },
        clientId: NEW_CLIENT_ID,
        secret: NEW_SECRET,
      },
    ]);
    expect(tfvars(w).service_token_ids).toEqual({ 'agent moi': NEW_ID });
    expect(w.tf.map((a) => a[0])).toEqual(['init', 'apply', 'output']);
    expect(leaked(w)).toEqual([]);
  });

  it('adopts an existing token and makes none', async () => {
    const w = world({ tokens: ['agent moi'], existing: [{ id: 'token-1', name: 'agent moi' }] });
    expect(await runWrapper('apply', { env: 'prod', ci: false }, w.io)).toBe(0);
    expect(w.posts).toEqual([]);
    expect(w.asked).toEqual([]);
    expect(tfvars(w).service_token_ids).toEqual({ 'agent moi': 'token-1' });
  });

  it('makes nothing and runs no terraform when the person does not say yes', async () => {
    const w = world({ tokens: ['agent moi'], confirm: false });
    expect(await runWrapper('apply', { env: 'prod', ci: false }, w.io)).toBe(1);
    expect(w.posts).toEqual([]);
    expect(w.tf).toEqual([]);
  });

  it('refuses before any write when the Keychain already holds the service', async () => {
    const w = world({ tokens: ['agent moi'], taken: ['cw-agent-moi-access-secret'] });
    expect(await runWrapper('apply', { env: 'prod', ci: false }, w.io)).toBe(1);
    expect(w.posts).toEqual([]);
    expect(w.asked).toEqual([]);
    expect(w.err.join('')).toContain('the Keychain already holds cw-agent-moi-access-secret');
  });

  it('refuses two names that would share one Keychain service', async () => {
    const w = world({ tokens: ['agent moi', 'agent-moi'] });
    expect(await runWrapper('apply', { env: 'prod', ci: false }, w.io)).toBe(1);
    expect(w.posts).toEqual([]);
  });

  it('a CI apply refuses a missing token: it has no Keychain, and terraform would keep the secret', async () => {
    const w = world({ tokens: ['agent moi'] });
    expect(await runWrapper('apply', { env: 'prod', ci: true }, w.io)).toBe(1);
    expect(w.posts).toEqual([]);
    expect(w.tf).toEqual([]);
    expect(w.err.join('')).toContain('on the Mac once');
  });

  it('CONTROL: a CI plan with a missing token still plans', async () => {
    const w = world({ tokens: ['agent moi'] });
    expect(await runWrapper('plan', { env: 'prod', ci: true }, w.io)).toBe(0);
    expect(w.tf.map((a) => a[0])).toEqual(['init', 'plan', 'show']);
  });

  it('stops before terraform, never repeating the store error, when the pair cannot be stored', async () => {
    const w = world({ tokens: ['agent moi'], storeFails: true });
    expect(await runWrapper('apply', { env: 'prod', ci: false }, w.io)).toBe(1);
    expect(w.tf).toEqual([]);
    expect(w.err.join('')).toContain(`Made service token "agent moi" (${NEW_ID})`);
    expect(leaked(w)).toEqual([]);
  });
});

describe('tokenServices', () => {
  it('names both Keychain services from the token name', () => {
    expect(tokenServices('agent moi')).toEqual({
      clientId: 'cw-agent-moi-access-client-id',
      secret: 'cw-agent-moi-access-secret',
    });
    expect(tokenServices('staging Relay  Riverbend').secret).toBe(
      'cw-staging-relay-riverbend-access-secret',
    );
  });
});

describe('keychainAdd', () => {
  /** A stand-in `security` that records its arguments and stdin. */
  function fakeSecurity(has: boolean): { bin: string; log: string } {
    const dir = mkdtempSync(join(tmpdir(), 'fake-security-'));
    const log = join(dir, 'log');
    const flag = join(dir, 'stored');
    if (has) writeFileSync(flag, '');
    const bin = join(dir, 'security');
    writeFileSync(
      bin,
      `#!/bin/sh
echo "args: $*" >> "${log}"
if [ "$1" = "find-generic-password" ]; then [ -f "${flag}" ]; exit $?; fi
echo "stdin: $(cat)" >> "${log}"
touch "${flag}"
`,
    );
    chmodSync(bin, 0o755);
    return { bin, log };
  }

  it('sends the value on stdin, never as an argument, and refuses to replace an item', () => {
    const { bin, log } = fakeSecurity(false);
    keychainAdd('cw-agent-moi-access-secret', NEW_SECRET, 'secret', bin);
    const lines = readFileSync(log, 'utf8').split('\n');
    expect(lines.filter((l) => l.startsWith('args:')).join('\n')).not.toContain(NEW_SECRET);
    expect(lines).toContainEqual(
      `stdin: add-generic-password -a claude-workspaces -s cw-agent-moi-access-secret -w "${NEW_SECRET}"`,
    );
    const taken = fakeSecurity(true);
    expect(() =>
      keychainAdd('cw-agent-moi-access-secret', NEW_SECRET, 'secret', taken.bin),
    ).toThrow('already holds');
  });

  it('refuses a value that could break out of the quoted argument, without naming it', () => {
    const { bin } = fakeSecurity(false);
    const hostile = `${NEW_SECRET}" -T /bin/sh "`;
    let message = '';
    try {
      keychainAdd('cw-agent-moi-access-secret', hostile, 'secret', bin);
    } catch (e) {
      message = e instanceof Error ? e.message : '';
    }
    expect(message).toContain('not shaped like an Access secret');
    expect(message).not.toContain(NEW_SECRET);
    expect(() => keychainAdd('cw-x-access-client-id', 'not-an-id', 'id', bin)).toThrow('client id');
  });
});
