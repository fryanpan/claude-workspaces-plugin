/**
 * Rotating one existing Access service token through the keeper
 * (`keeper/keeper-rotate.ts`), and storing the new pair over the old one
 * (`infra/cloudflare/rotate-token.ts`): one tap, the old secret kept for 24
 * hours, the page naming the token and never a secret, and the secret
 * reaching only the requester. A stand-in Cloudflare; nothing leaves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { rotateToken } from '../../../infra/cloudflare/rotate-token.ts';
import type { TokenServices } from '../../../infra/cloudflare/service-tokens.ts';
import type { Executors } from '../src/keeper/keeper-requests.ts';
import {
  PREVIOUS_SECRET_MS,
  classifyRotate,
  rotateServiceToken,
} from '../src/keeper/keeper-rotate.ts';
import { type LiveKeeper, startLiveKeeper } from './keeper-live-harness.ts';

const ACCOUNT = 'a'.repeat(32);
const SECRET = 'feedface'.repeat(8);
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);

function fakeCloudflare(tokens: { id: string; name: string }[]) {
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  const cf: Executors['cloudflare'] = async (method, path, body) => {
    calls.push({ method, path, ...(body ? { body } : {}) });
    const ok = (result: unknown) => ({
      status: 200,
      body: JSON.stringify({ success: true, result }),
    });
    if (path === '/accounts') return ok([{ id: ACCOUNT }]);
    if (path.startsWith(`/accounts/${ACCOUNT}/access/service_tokens?`)) return ok(tokens);
    if (method === 'POST' && path.endsWith('/rotate')) {
      return ok({ client_id: 'c0ffee.access', client_secret: SECRET });
    }
    return { status: 404, body: '{}' };
  };
  return { cf, calls };
}

describe('rotateServiceToken', () => {
  it('rotates the one token with that name, keeping the old secret for 24 hours', async () => {
    const f = fakeCloudflare([
      { id: 'tok-1', name: 'agent moi' },
      { id: 'tok-2', name: 'agent riverbend' },
    ]);
    const r = await rotateServiceToken(f.cf, 'agent moi', NOW);
    expect(r.status).toBe(200);
    const post = f.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe(`/accounts/${ACCOUNT}/access/service_tokens/tok-1/rotate`);
    const expires = new Date(NOW + PREVIOUS_SECRET_MS).toISOString();
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ previous_client_secret_expires_at: expires });
    expect(JSON.parse(r.body)).toEqual({
      name: 'agent moi',
      id: 'tok-1',
      clientId: 'c0ffee.access',
      secret: SECRET,
      previousSecretExpiresAt: expires,
    });
  });

  it('rotates nothing when no token, or more than one, has the name', async () => {
    for (const tokens of [
      [],
      [
        { id: 'a', name: 'agent moi' },
        { id: 'b', name: 'agent moi' },
      ],
    ]) {
      const f = fakeCloudflare(tokens);
      const r = await rotateServiceToken(f.cf, 'agent moi', NOW);
      expect(r.status).toBe(404);
      expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
    }
  });

  it('refuses a name that is not a token name', () => {
    expect(classifyRotate('agent moi')).toMatchObject({
      kind: 'held',
      hold: 'service-token.rotate',
    });
    for (const bad of ['', '../x', 'a\nb', 'x'.repeat(101), 7])
      expect(classifyRotate(bad).kind).toBe('refused');
  });
});

describe('service-token-rotate through the keeper', () => {
  const f = fakeCloudflare([{ id: 'tok-1', name: 'agent moi' }]);
  let k: LiveKeeper;
  beforeAll(async () => {
    k = await startLiveKeeper(
      { fly: async () => ({ status: 0, stdout: '', stderr: '' }), cloudflare: f.cf },
      'keeper-rotate',
    );
  });
  afterAll(async () => k?.stop());

  it('is held, its page names the token, and only the poll carries the secret', async () => {
    const r = await k.submit('/v1/service-token-rotate', { name: 'agent moi' });
    expect(r.status).toBe(202);
    expect(f.calls).toEqual([]);
    const page = await k.page(r.body.id as string);
    expect(page).toContain('<code id="token">agent moi</code>');
    const approved = await k.approve(r.body.id as string);
    expect(approved.status).toBe(200);
    expect(approved.text).not.toContain(SECRET);
    const done = await k.poll(r.body.id as string, r.body.pollToken as string);
    expect(JSON.parse(done.result?.body ?? '{}').secret).toBe(SECRET);
  });

  it('a raw Cloudflare rotate through the generic path is refused', async () => {
    const r = await k.submit(
      `/v1/cloudflare/accounts/${ACCOUNT}/access/service_tokens/tok-1/rotate`,
      {},
    );
    expect(r.status).toBe(403);
  });
});

describe('cf:rotate-token', () => {
  const io = (status: number, body: unknown, fails = false) => {
    const w = {
      replaced: [] as Array<{ services: TokenServices; clientId: string; secret: string }>,
      printed: [] as string[],
    };
    return {
      w,
      io: {
        rotate: async () => ({ status, body: JSON.stringify(body) }),
        replaceToken: (services: TokenServices, clientId: string, secret: string) => {
          if (fails) throw new Error(`refused ${secret}`);
          w.replaced.push({ services, clientId, secret });
        },
        out: (s: string) => w.printed.push(s),
        err: (s: string) => w.printed.push(s),
      },
    };
  };

  it('puts the new pair over the old one under the token services, never printing it', async () => {
    const { w, io: x } = io(200, {
      clientId: 'c0ffee.access',
      secret: SECRET,
      previousSecretExpiresAt: 'later',
    });
    expect(await rotateToken('agent moi', x)).toBe(0);
    expect(w.replaced).toEqual([
      {
        services: {
          clientId: 'cw-agent-moi-access-client-id',
          secret: 'cw-agent-moi-access-secret',
        },
        clientId: 'c0ffee.access',
        secret: SECRET,
      },
    ]);
    expect(w.printed.join('')).not.toContain(SECRET);
    expect(w.printed.join('')).toContain('a second rotation ends the old secret at once');
  });

  it('says the secret is lost, without printing it, when the Keychain refuses it', async () => {
    const { w, io: x } = io(200, { clientId: 'c0ffee.access', secret: SECRET }, true);
    expect(await rotateToken('agent moi', x)).toBe(1);
    expect(w.printed.join('')).toContain('it is lost');
    expect(w.printed.join('')).not.toContain(SECRET);
  });

  it("prints the keeper's refusal and stores nothing", async () => {
    const { w, io: x } = io(403, { error: 'request was denied' });
    expect(await rotateToken('agent moi', x)).toBe(1);
    expect(w.replaced).toEqual([]);
    expect(w.printed.join('')).toContain('request was denied');
  });
});
