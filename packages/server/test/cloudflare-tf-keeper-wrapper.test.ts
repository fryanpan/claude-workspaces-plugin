/**
 * `cf:plan` / `cf:apply` on the Mac through the keeper
 * (`infra/cloudflare/keeper-wrapper.ts`): which runs go through it, that this
 * side sends the configs and the state credential and reads no Cloudflare
 * token, that an apply waits on the keeper and prints what it applied, and
 * that a new service token's pair goes straight to the Keychain and is never
 * printed. A stand-in keeper and Keychain; nothing reaches the real keeper.
 */
import { describe, expect, it } from 'bun:test';
import {
  type KeeperWrapperIo,
  runThroughKeeper,
} from '../../../infra/cloudflare/keeper-wrapper.ts';
import { throughKeeper } from '../../../infra/cloudflare/run.ts';
import type { TokenServices } from '../../../infra/cloudflare/service-tokens.ts';
import { CONFIG_PATHS } from '../../../infra/cloudflare/vars.ts';
import type { FlyResult } from '../../src/keeper/keeper-requests.ts';

const SECRET = 'feedface'.repeat(8);
const ok = (r: Record<string, unknown>): FlyResult => ({
  status: 0,
  stdout: `${JSON.stringify({ ok: true, ...r })}\n`,
  stderr: '',
});
const PLAN = (missing: Record<string, string> = {}) =>
  ok({ mode: 'plan', text: 'Plan: 1 to change.\n', changes: 1, missing });
const APPLIED = ok({
  mode: 'apply',
  text: 'Apply complete!\n',
  audiences: ['riverbend: CF_ACCESS_AUD=aud-1'],
});
const MINTED = ok({
  mode: 'mint',
  minted: [
    {
      name: 'agent moi',
      id: 'token-1',
      services: { clientId: 'cw-agent-moi-access-client-id', secret: 'cw-agent-moi-access-secret' },
      clientId: 'c0ffee.access',
      secret: SECRET,
    },
  ],
});

interface World {
  io: KeeperWrapperIo;
  calls: Array<{ command: string; env: string; input: Record<string, unknown> }>;
  read: string[];
  stored: Array<{ services: TokenServices; clientId: string; secret: string }>;
  out: string[];
  err: string[];
}

function world(answers: FlyResult[], opts: { taken?: string[]; storeFails?: boolean } = {}) {
  const w: World = { calls: [], read: [], stored: [], out: [], err: [], io: undefined as never };
  w.io = {
    read: (rel) => (rel === CONFIG_PATHS.prod.access ? '{"projects":{}}' : null),
    env: {},
    keychainHas: (n) => n === 'cloudflare-r2-tfstate',
    keychainRead: (n) => {
      w.read.push(n);
      return JSON.stringify({ accessKeyId: 'r2-id', secretAccessKey: 'r2-secret' });
    },
    keychainHasService: (s) => (opts.taken ?? []).includes(s),
    storeToken: (services, clientId, secret) => {
      if (opts.storeFails) throw new Error(`refused ${secret}`);
      w.stored.push({ services, clientId, secret });
    },
    keeper: async (command, env, input) => {
      w.calls.push({ command, env, input: JSON.parse(input) });
      return answers.shift() ?? { status: 1, stdout: '', stderr: 'no answer scripted' };
    },
    out: (s) => w.out.push(s),
    err: (s) => w.err.push(s),
  };
  return w;
}

const printed = (w: World) => [...w.out, ...w.err].join('');

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
  it('sends the configs and the state credential, reads no Cloudflare token, and prints the plan', async () => {
    const w = world([PLAN()]);
    expect(await runThroughKeeper('plan', 'prod', w.io)).toBe(0);
    expect(w.calls).toEqual([
      {
        command: 'plan',
        env: 'prod',
        input: {
          configs: { access: '{"projects":{}}' },
          state: { accessKeyId: 'r2-id', secretAccessKey: 'r2-secret' },
        },
      },
    ]);
    expect(w.read).toEqual(['cloudflare-r2-tfstate']);
    expect(w.out.join('')).toContain('Plan: 1 to change.');
  });

  it('prints what the keeper said when the run fails', async () => {
    const w = world([
      { status: 1, stdout: '{"ok":false,"error":"refused","refusals":["a"]}', stderr: 'boom' },
    ]);
    expect(await runThroughKeeper('plan', 'prod', w.io)).toBe(1);
    expect(w.err.join('')).toContain('boom');
    expect(w.err.join('')).toContain('  - a');
  });
});

describe('cf:apply through the keeper', () => {
  it('prints the plan, waits on the keeper, and prints what it applied', async () => {
    const w = world([PLAN(), APPLIED]);
    expect(await runThroughKeeper('apply', 'prod', w.io)).toBe(0);
    expect(w.calls.map((c) => c.command)).toEqual(['plan', 'apply']);
    expect(w.out.join('')).toContain('riverbend: CF_ACCESS_AUD=aud-1');
    expect(w.out.join('')).toContain('Applied to prod.');
  });

  it('stores a new token pair in the Keychain, never prints it, then applies', async () => {
    const w = world([PLAN({ 'agent moi': 'agent moi' }), MINTED, APPLIED]);
    expect(await runThroughKeeper('apply', 'prod', w.io)).toBe(0);
    expect(w.calls.map((c) => c.command)).toEqual(['plan', 'apply', 'apply']);
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
    expect(printed(w)).not.toContain(SECRET);
  });

  it('refuses before any token is made when the Keychain already holds its service', async () => {
    const w = world([PLAN({ 'agent moi': 'agent moi' })], {
      taken: ['cw-agent-moi-access-secret'],
    });
    expect(await runThroughKeeper('apply', 'prod', w.io)).toBe(1);
    expect(w.calls.map((c) => c.command)).toEqual(['plan']);
    expect(w.err.join('')).toContain('the Keychain already holds cw-agent-moi-access-secret');
  });

  it('says the secret is lost, without printing it, when the Keychain refuses the pair', async () => {
    const w = world([PLAN({ 'agent moi': 'agent moi' }), MINTED], { storeFails: true });
    expect(await runThroughKeeper('apply', 'prod', w.io)).toBe(1);
    expect(w.err.join('')).toContain('Its secret is lost');
    expect(printed(w)).not.toContain(SECRET);
  });

  it('a plan with nothing to change ends without a tap', async () => {
    const w = world([PLAN(), ok({ mode: 'plan', text: '', changes: 0, missing: {} })]);
    expect(await runThroughKeeper('apply', 'prod', w.io)).toBe(0);
    expect(w.out.join('')).toContain('No changes to apply to prod.');
  });
});
