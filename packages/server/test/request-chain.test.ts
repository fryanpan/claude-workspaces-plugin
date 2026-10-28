/**
 * The request chain's front door and gates (routes/request-chain.ts), driven
 * directly with a context whose families are never reached.
 *
 * What is pinned here is the ORDER at the top of the chain: the bad-path
 * refusal answers before anything decodes, the preflight before the write
 * gate, the write gate before admission, and admission's own answer is what
 * the caller gets. Every response still goes out through CORS and the
 * session refresh. The families below the gates run through the real server
 * in the rest of this suite.
 */
import { describe, expect, it } from 'bun:test';
import type { Admission } from '../src/request-admission.ts';
import type { RequestChainContext } from '../src/routes/request-chain-context.ts';
import { createRequestChain } from '../src/routes/request-chain.ts';

const j = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Seen {
  cors: string[];
  refreshed: string[];
  admitted: string[];
  prewarmed: string[];
}

/** Only the front door and the gates above admission are real values. */
const chain = (admit: (req: Request) => Admission) => {
  const seen: Seen = { cors: [], refreshed: [], admitted: [], prewarmed: [] };
  const ctx = {
    docStore: {
      noteRequest: () => {},
      prewarmHydration: async (id: string) => {
        seen.prewarmed.push(id);
      },
    },
    applyCors: (req: Request, res: Response) => {
      seen.cors.push(new URL(req.url).pathname);
      return res;
    },
    refreshSession: (req: Request, res: Response) => {
      seen.refreshed.push(new URL(req.url).pathname);
      return res;
    },
    slowRequestMs: Number.POSITIVE_INFINITY,
    policyFor: () => ({
      requestOrigin: 'http://localhost',
      localHostnames: ['localhost'],
      allowedOrigins: [],
    }),
    isValidDocId: (s: string) => /^[a-z0-9-]{1,40}$/.test(s),
    j,
    requestAddress: () => '127.0.0.1',
    homeFeedCtx: { j },
    admit: async (req: Request) => {
      seen.admitted.push(new URL(req.url).pathname);
      return admit(req);
    },
  } as unknown as RequestChainContext;
  return { handle: createRequestChain(ctx), seen };
};

const refused = (): Admission => ({ admitted: false, response: j(403, { error: 'refused' }) });

describe('createRequestChain', () => {
  it('answers a malformed path segment before any gate, through CORS', async () => {
    const { handle, seen } = chain(refused);
    const res = await handle(new Request('http://localhost/api/docs/%E0%A4%A'));
    expect(res?.status).toBe(400);
    expect(await res?.json()).toMatchObject({ error: 'bad-path' });
    expect(seen.cors).toEqual(['/api/docs/%E0%A4%A']);
    expect(seen.admitted).toEqual([]);
  });

  it('answers a preflight before admission', async () => {
    const { handle, seen } = chain(refused);
    const res = await handle(new Request('http://localhost/api/docs', { method: 'OPTIONS' }));
    expect(res?.status).toBe(204);
    expect(seen.admitted).toEqual([]);
    expect(seen.cors).toEqual(['/api/docs']);
    expect(seen.refreshed).toEqual(['/api/docs']);
  });

  it('refuses a cross-origin write before admission', async () => {
    const { handle, seen } = chain(refused);
    const res = await handle(
      new Request('http://localhost/api/docs', {
        method: 'POST',
        headers: { origin: 'https://riverbend.example' },
        body: '{}',
      }),
    );
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: 'origin_not_allowed' });
    expect(seen.admitted).toEqual([]);
  });

  it("hands back admission's own answer, through CORS and the session refresh", async () => {
    const { handle, seen } = chain(refused);
    const res = await handle(new Request('http://localhost/workspaces/w-1/docs/plan-a'));
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: 'refused' });
    expect(seen.admitted).toEqual(['/workspaces/w-1/docs/plan-a']);
    expect(seen.cors).toEqual(['/workspaces/w-1/docs/plan-a']);
    expect(seen.refreshed).toEqual(['/workspaces/w-1/docs/plan-a']);
  });

  it('prewarms every segment that could name a doc before routing', async () => {
    const { handle, seen } = chain(refused);
    await handle(new Request('http://localhost/workspaces/w-1/docs/plan-a?docId=notes-b'));
    expect(seen.prewarmed).toEqual(['workspaces', 'w-1', 'docs', 'plan-a', 'notes-b']);
  });
});
