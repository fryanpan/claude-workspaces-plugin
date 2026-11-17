/**
 * The Mac's side of the keeper's Cloudflare requests: `cf:plan`
 * (`infra/cloudflare/keeper-wrapper.ts`) sends the configs and the state
 * credential, reads no Cloudflare token and prints the plan; `cf:sync-config`
 * (`infra/cloudflare/sync-config.ts`) refuses a Keychain collision before
 * asking, then puts a new token's pair straight into the Keychain, never
 * printed, even when a later step failed. A stand-in keeper and Keychain;
 * nothing reaches the real keeper.
 */
import { describe, expect, it } from 'bun:test';
import {
  type KeeperWrapperIo,
  runThroughKeeper,
} from '../../../infra/cloudflare/keeper-wrapper.ts';
import { throughKeeper } from '../../../infra/cloudflare/run.ts';
import type { TokenServices } from '../../../infra/cloudflare/service-tokens.ts';
import { type SyncIo, syncConfig } from '../../../infra/cloudflare/sync-config.ts';
import { CONFIG_PATHS } from '../../../infra/cloudflare/vars.ts';
import type { CloudflareResult, FlyResult } from '../src/keeper/keeper-requests.ts';

const SECRET = 'feedface'.repeat(8);
const ok = (r: Record<string, unknown>): FlyResult => ({
  status: 0,
  stdout: `${JSON.stringify({ ok: true, ...r })}\n`,
  stderr: '',
});
const PLAN = (missing: Record<string, string> = {}) =>
  ok({ mode: 'plan', text: 'Plan: 1 to change.\n', changes: 1, missing });
const MINTED = [{ name: 'agent moi', id: 'token-1', clientId: 'c0ffee.access', secret: SECRET }];

const inputs = {
  read: (rel: string) => (rel === CONFIG_PATHS.prod.access ? '{"projects":{}}' : null),
  env: {},
  keychainHas: (n: string) => n === 'cloudflare-r2-tfstate',
  keychainRead: () => JSON.stringify({ accessKeyId: 'r2-id', secretAccessKey: 'r2-secret' }),
};
const SENT = {
  configs: { access: '{"projects":{}}' },
  state: { accessKeyId: 'r2-id', secretAccessKey: 'r2-secret' },
};

describe('throughKeeper', () => {
  it('a local run with the keeper set goes through it; CI and an explicit token do not', () => {
    expect(throughKeeper({ CW_KEEPER_URL: 'http://localhost:41234' }, false)).toBe(true);
    expect(throughKeeper({ CW_KEEPER_URL: 'http://localhost:41234' }, true)).toBe(false);
    expect(
      throughKeeper({ CW_KEEPER_URL: 'http://localhost:41234', CLOUDFLARE_API_TOKEN: 't' }, false),
    ).toBe(false);
    expect(throughKeeper({}, false)).toBe(false);
  });
});

describe('cf:plan through the keeper', () => {
  const world = (answer: FlyResult) => {
    const w = { sent: [] as unknown[], out: [] as string[], err: [] as string[] };
    const io: KeeperWrapperIo = {
      ...inputs,
      keeper: async (env, input) => {
        w.sent.push({ env, input: JSON.parse(input) });
        return answer;
      },
      out: (s) => w.out.push(s),
      err: (s) => w.err.push(s),
    };
    return { w, io };
  };

  it('sends the configs and the state credential, reads no Cloudflare token, and prints the plan', async () => {
    const { w, io } = world(PLAN({ 'agent moi': 'agent moi' }));
    expect(await runThroughKeeper('prod', io)).toBe(0);
    expect(w.sent).toEqual([{ env: 'prod', input: SENT }]);
    expect(w.out.join('')).toContain('Plan: 1 to change.');
    expect(w.out.join('')).toContain('cf:sync-config makes it');
  });

  it('prints what the keeper said when the run fails', async () => {
    const { w, io } = world({
      status: 1,
      stdout: '{"ok":false,"error":"refused","refusals":["a"]}',
      stderr: 'boom',
    });
    expect(await runThroughKeeper('prod', io)).toBe(1);
    expect(w.err.join('')).toContain('boom');
    expect(w.err.join('')).toContain('  - a');
  });
});

describe('cf:sync-config', () => {
  const world = (
    plan: FlyResult,
    sync: CloudflareResult,
    opts: { taken?: string[]; storeFails?: boolean } = {},
  ) => {
    const w = {
      synced: [] as unknown[],
      stored: [] as Array<{ services: TokenServices; clientId: string; secret: string }>,
      out: [] as string[],
      err: [] as string[],
    };
    const io: SyncIo = {
      ...inputs,
      keychainHasService: (s) => (opts.taken ?? []).includes(s),
      storeToken: (services, clientId, secret) => {
        if (opts.storeFails) throw new Error(`refused ${secret}`);
        w.stored.push({ services, clientId, secret });
      },
      plan: async () => plan,
      sync: async (input) => {
        w.synced.push(JSON.parse(input));
        return sync;
      },
      out: (s) => w.out.push(s),
      err: (s) => w.err.push(s),
    };
    return { w, io, printed: () => [...w.out, ...w.err].join('') };
  };
  const synced = (body: Record<string, unknown>, status = 200): CloudflareResult => ({
    status,
    body: JSON.stringify(body),
  });

  it('sends the configs, stores the new pair in the Keychain unprinted, and says CI started', async () => {
    const { w, io, printed } = world(
      PLAN({ 'agent moi': 'agent moi' }),
      synced({
        written: ['repository/CF_ACCESS_CONFIG'],
        dispatched: 'cloudflare.yml@main',
        minted: MINTED,
      }),
    );
    expect(await syncConfig(io)).toBe(0);
    expect(w.synced).toEqual([SENT]);
    expect(w.stored).toEqual([
      {
        services: {
          clientId: 'cw-agent-moi-access-client-id',
          secret: 'cw-agent-moi-access-secret',
        },
        clientId: 'c0ffee.access',
        secret: SECRET,
      },
    ]);
    expect(w.out.join('')).toContain('Started cloudflare.yml@main');
    expect(printed()).not.toContain(SECRET);
  });

  it('refuses before asking the keeper when the Keychain already holds a token service', async () => {
    const { w, io } = world(PLAN({ 'agent moi': 'agent moi' }), synced({}), {
      taken: ['cw-agent-moi-access-secret'],
    });
    expect(await syncConfig(io)).toBe(1);
    expect(w.synced).toEqual([]);
    expect(w.err.join('')).toContain('the Keychain already holds cw-agent-moi-access-secret');
  });

  it('refuses before asking the keeper when two names would share one Keychain service', async () => {
    const { w, io } = world(PLAN({ a: 'agent moi', b: 'agent-moi' }), synced({}));
    expect(await syncConfig(io)).toBe(1);
    expect(w.synced).toEqual([]);
    expect(w.err.join('')).toContain('"agent moi" and "agent-moi" would share');
  });

  it('stores a made token even when GitHub then refused, and fails', async () => {
    const { w, io } = world(
      PLAN({ 'agent moi': 'agent moi' }),
      synced({ error: 'GitHub did not take CF_ACCESS_CONFIG', minted: MINTED }, 502),
    );
    expect(await syncConfig(io)).toBe(1);
    expect(w.stored).toHaveLength(1);
    expect(w.err.join('')).toContain('GitHub did not take CF_ACCESS_CONFIG');
  });

  it('says the secret is lost, without printing it, when the Keychain refuses the pair', async () => {
    const { io, printed } = world(
      PLAN({ 'agent moi': 'agent moi' }),
      synced({ written: [], dispatched: 'cloudflare.yml@main', minted: MINTED }),
      { storeFails: true },
    );
    expect(await syncConfig(io)).toBe(1);
    expect(printed()).toContain('Its secret is lost: run bun run cf:rotate-token "agent moi"');
    expect(printed()).not.toContain(SECRET);
  });

  it('a denied tap writes nothing here and fails', async () => {
    const { w, io } = world(PLAN(), synced({ error: 'cf-sync was denied' }, 403));
    expect(await syncConfig(io)).toBe(1);
    expect(w.stored).toEqual([]);
    expect(w.err.join('')).toContain('was denied');
  });
});
