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
  authShareRoutesCtx: { j },
  opsRoutesCtx: { j, requestAddress: () => '127.0.0.1' },
  mountRoutesCtx: { j },
  inboxRoutes: () => null,
  promptRoutesCtx: { j },
  reviewQueueRoutesCtx: { j },
  voicePageRoutesCtx: { j },
  voiceApiRoutesCtx: { j, tokens: { verify: () => null } },
  accessRoutesCtx: { j },
  coachRoutesCtx: { j, wiring: {} },
  voiceAgentLlmRoutesCtx: { j },
  recallWebhookRoutesCtx: { j },
  mcpConnectorCtx: { j, boardOfSocket: () => null },
  agentIdentityRoutesCtx: { j },
  boardTokenRoutesCtx: { j },
  boardSocketRootsRoutesCtx: { j },
  repoRoutesCtx: { j },
  loadReportRoutesCtx: { j },
  landingStreamCtx: { j },
  privateMessageRoutesCtx: { j },
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

  it('keeps the operator routes’ visitor refusal', async () => {
    // routes/ops.ts refuses a share visitor before its loopback and `cf-ray` tests.
    const res = await front(at('/api/deploy', { method: 'POST' }), envFor(true));
    expect(res?.status).toBe(403);
  });

  it('hands back null for addresses no moved family claims', async () => {
    const unclaimed = [
      '/workspaces/w-1/tasks',
      '/api/docs',
      '/coach',
      '/voice-agent/v1/x',
      // Beside the share family's patterns, but not under them.
      '/api/sharex',
      '/s/a/b',
      '/share/a/b',
      '/workspaces/w-1/git/push',
      // Beside the batch-three families' patterns, but not under them.
      '/mcp/x',
      '/api/agents/a-1',
      '/api/agents/a-1/messages',
      '/api/board-sockets/w-1',
      '/api/load-reports/x',
      '/landing/events',
    ];
    for (const path of unclaimed) {
      expect(await front(at(path), envFor(false))).toBeNull();
    }
  });

  it('reaches the batch-three families at their own refusals', async () => {
    // routes/mcp-connector.ts refuses a share visitor on a plain socket.
    expect((await front(at('/mcp', { method: 'POST' }), envFor(true)))?.status).toBe(403);
    // routes/landing-stream.ts answers 405 to anything but a GET.
    expect(
      (await front(at('/landing/events:stream', { method: 'POST' }), envFor(false)))?.status,
    ).toBe(405);
    // routes/private-messages.ts wants a person, never a share visitor.
    const mine = await front(at('/api/me/messages'), envFor(true));
    expect(mine?.status).toBe(403);
    expect(await mine?.json()).toEqual({ error: 'person_proof_required' });
    // routes/agent-identity.ts refuses a share visitor its stream bearer.
    expect((await front(at('/api/agents/a-1/token'), envFor(true)))?.status).toBe(403);
  });

  it('answers Recall’s status POST itself, so the `/recall/` upgrade never sees it', async () => {
    // With no webhook secret configured the route answers its own 404 —
    // not null, which would hand the request on to the chain's upgrade block.
    const res = await front(at('/recall/status', { method: 'POST' }), envFor(false));
    expect(res?.status).toBe(404);
    expect(await res?.json()).toEqual({ error: 'not_found' });
    expect(await front(at('/recall/b-1'), envFor(false))).toBeNull();
  });

  it('answers a HEAD with the status and headers of its answer and no body', async () => {
    const res = await front(at('/v1/models', { method: 'HEAD' }), envFor(false));
    expect(res?.status).toBe(401);
    expect(res?.headers.get('content-type')).toBe('application/json');
    expect(await res?.text()).toBe('');
  });
});
