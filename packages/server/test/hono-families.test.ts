/**
 * `honoFamilies` on its own: the moved families mounted on a Hono front,
 * with stub contexts that reach only each handler's first refusal.
 *
 * What the whole server answers at every route-table address is
 * `route-answers.test.ts`; this file holds the edges that table does not
 * reach — an address only a loose prefix test claims, an address a family
 * declines, and a HEAD answered with a body.
 */
import { describe, expect, it } from 'bun:test';
import type { HonoGateEnv } from '../src/hono-env.ts';
import { type HonoFamiliesContext, honoFamilies } from '../src/routes/hono-families.ts';
import { createHonoFront } from '../src/routes/hono-front.ts';

const j = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const ctx = {
  promptRoutesCtx: { j },
  reviewQueueRoutesCtx: { j },
  voicePageRoutesCtx: { j },
  voiceApiRoutesCtx: { j, tokens: { verify: () => null } },
  accessRoutesCtx: { j },
  coachRoutesCtx: { j, wiring: {} },
  requireSignInToWrite: false,
  policyFor: () => ({ requestOrigin: undefined }),
} as unknown as HonoFamiliesContext;

const envFor = (visitor: boolean) =>
  ({
    gate: { visitor: visitor ? { shareId: 's-1' } : null },
    attribution: {
      authorFor: () => null,
      provenIdentityFor: () => null,
      browserProvedNobody: () => true,
    },
    ownerProven: () => false,
  }) as unknown as HonoGateEnv;

const at = (path: string, init: RequestInit = {}) => new Request(`http://localhost${path}`, init);

describe('honoFamilies', () => {
  const front = createHonoFront(honoFamilies(ctx));

  it('reaches every address a loose prefix test claims', async () => {
    // routes/prompts.ts refuses a visitor anywhere under `startsWith('/api/prompts')`,
    // including paths with no slash after the word and paths two segments deep.
    for (const path of ['/api/prompts', '/api/promptsx', '/api/prompts/a/b']) {
      const res = await front(at(path), envFor(true));
      expect(res?.status).toBe(403);
    }
    const coach = await front(at('/coach/anything/deeper', { method: 'POST' }), envFor(false));
    // Any POST under `/coach/` meets the owner check, even an unknown verb.
    expect(coach?.status).toBe(403);
  });

  it('hands back null for an address its family declines', async () => {
    // Under the prompts pattern, but neither the list, the stream nor one id.
    expect(await front(at('/api/prompts/a/b'), envFor(false))).toBeNull();
    // Under the tokens pattern, but too short to be a token id.
    expect(await front(at('/api/voice/tokens/short/revoke'), envFor(false))).toBeNull();
    expect(await front(at('/access/a/b'), envFor(false))).toBeNull();
  });

  it('hands back null for addresses no moved family claims', async () => {
    for (const path of ['/workspaces/w-1/tasks', '/api/docs', '/coach', '/voice-agent/v1/x']) {
      expect(await front(at(path), envFor(false))).toBeNull();
    }
  });

  it('answers a HEAD with the status and headers of its answer and no body', async () => {
    const res = await front(at('/v1/models', { method: 'HEAD' }), envFor(false));
    expect(res?.status).toBe(401);
    expect(res?.headers.get('content-type')).toBe('application/json');
    expect(await res?.text()).toBe('');
  });
});
