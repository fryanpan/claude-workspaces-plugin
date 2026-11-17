/**
 * CI's rotation of one Access service token (`infra/cloudflare/ci-rotate-token.ts`):
 * the request Cloudflare is sent, the mask lines printed before anything
 * else, the pair sealed to the Mac's key and nowhere in the log, and the
 * refusals that come before any rotation. A stand-in Cloudflare and bucket.
 */
import { describe, expect, it } from 'bun:test';
import nacl from 'tweetnacl';
import {
  type CiRotateIo,
  ciRotate,
  cloudflareFetch,
} from '../../../infra/cloudflare/ci-rotate-token.ts';
import { PREVIOUS_SECRET_MS } from '../src/keeper/keeper-rotate.ts';
import { dropKey, openDrop } from '../src/token-drop/token-drop-blob.ts';

const ACCOUNT = 'a'.repeat(32);
const NAME = 'agent harborlight';
const CLIENT = 'c0ffee.access';
const SECRET = 'feedface'.repeat(8);
const NOW = Date.UTC(2026, 10, 16, 9, 0, 0);

function harness(
  opts: { put?: (k: string, b: string) => Promise<void>; pub?: string | null } = {},
) {
  const pair = nacl.box.keyPair();
  const keys = {
    publicKeyB64: Buffer.from(pair.publicKey).toString('base64'),
    secretKeyB64: Buffer.from(pair.secretKey).toString('base64'),
  };
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  const objects: Record<string, string> = {};
  const out: string[] = [];
  const err: string[] = [];
  let now = NOW;
  const io: CiRotateIo = {
    cf: async (method, path, body) => {
      calls.push({ method, path, ...(body ? { body } : {}) });
      const ok = (result: unknown) => ({
        status: 200,
        body: JSON.stringify({ success: true, result }),
      });
      if (path === '/accounts') return ok([{ id: ACCOUNT }]);
      if (path.startsWith(`/accounts/${ACCOUNT}/access/service_tokens?`)) {
        return ok([{ id: 'tok-1', name: NAME }]);
      }
      if (method === 'POST' && path.endsWith('/rotate')) {
        return ok({ client_id: CLIENT, client_secret: SECRET });
      }
      return { status: 404, body: '{}' };
    },
    publicKey: () => (opts.pub === undefined ? keys.publicKeyB64 : opts.pub),
    get: async (k) => objects[k] ?? null,
    put:
      opts.put ??
      (async (k, b) => {
        objects[k] = b;
      }),
    now: () => now,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  };
  return { io, keys, calls, objects, out, err, advance: (ms: number) => (now += ms) };
}

/** Everything printed, minus the mask lines that exist to carry the values. */
const printed = (h: { out: string[]; err: string[] }) =>
  [...h.out, ...h.err].filter((l) => !l.startsWith('::add-mask::')).join('');

describe('ciRotate', () => {
  it('rotates the named token, masks first, and seals the pair to the Mac', async () => {
    const h = harness();
    expect(await ciRotate([NAME], h.io)).toBe(0);
    const post = h.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe(`/accounts/${ACCOUNT}/access/service_tokens/tok-1/rotate`);
    expect(JSON.parse(post?.body ?? '{}')).toEqual({
      previous_client_secret_expires_at: new Date(NOW + PREVIOUS_SECRET_MS).toISOString(),
    });
    expect(h.out.slice(0, 2)).toEqual([`::add-mask::${SECRET}\n`, `::add-mask::${CLIENT}\n`]);
    expect(printed(h)).not.toContain(SECRET);
    const text = h.objects[dropKey(NAME)] ?? '';
    expect(text).not.toContain(SECRET);
    expect(openDrop(text, dropKey(NAME), h.keys)).toEqual({
      ok: true,
      pair: {
        name: NAME,
        clientId: CLIENT,
        secret: SECRET,
        rotatedAt: new Date(NOW).toISOString(),
      },
    });
  });

  it('refuses before any rotation without the public key, or with a bad name', async () => {
    const h = harness({ pub: null });
    expect(await ciRotate([NAME], h.io)).toBe(1);
    expect(h.err.join('')).toContain('token-drop.pub');
    const bad = harness();
    expect(await ciRotate(['::stop-commands::x'], bad.io)).toBe(2);
    for (const x of [h, bad]) expect(x.calls).toEqual([]);
  });

  it('refuses a second rotation inside 24 hours unless forced', async () => {
    const h = harness();
    await ciRotate([NAME], h.io);
    h.advance(60 * 60_000);
    expect(await ciRotate([NAME], h.io)).toBe(1);
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(await ciRotate([NAME, '--force'], h.io)).toBe(0);
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('says the secret is lost, without it, when the upload fails', async () => {
    const h = harness({
      put: async () => {
        throw new Error(`upload of ${SECRET} failed`);
      },
    });
    expect(await ciRotate([NAME], h.io)).toBe(1);
    expect(h.err.join('')).toContain('it is lost');
    expect(printed(h)).not.toContain(SECRET);
  });
});

describe('cloudflareFetch', () => {
  it('puts the token in the Authorization header only', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await cloudflareFetch('tok-value', fake)('GET', '/accounts', undefined);
    expect(seen[0]?.url).toBe('https://api.cloudflare.com/client/v4/accounts');
    expect((seen[0]?.init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok-value',
    );
  });
});
