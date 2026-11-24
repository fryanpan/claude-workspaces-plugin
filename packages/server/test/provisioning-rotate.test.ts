/**
 * Rotating one existing Access service token (`provisioning/rotate.ts`):
 * the old secret kept for 24 hours. cf-rotate-token.yml runs it
 * (`cloudflare-rotate-token.test.ts`).
 * A stand-in Cloudflare; nothing leaves.
 */
import { describe, expect, it } from 'bun:test';
import {
  PREVIOUS_SECRET_MS,
  classifyRotate,
  rotateServiceToken,
} from '../src/provisioning/rotate.ts';

const ACCOUNT = 'a'.repeat(32);
const SECRET = 'feedface'.repeat(8);
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);

function fakeCloudflare(tokens: { id: string; name: string }[]) {
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  const cf: Parameters<typeof rotateServiceToken>[0] = async (method, path, body) => {
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
    expect(classifyRotate('agent moi')).toEqual({ kind: 'ok', name: 'agent moi' });
    for (const bad of ['', '../x', 'a\nb', 'x'.repeat(101), 7])
      expect(classifyRotate(bad).kind).toBe('refused');
  });
});
