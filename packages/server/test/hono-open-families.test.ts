/**
 * `honoOpenFamilies` on its own: the home feed, the board import and the
 * GitHub hub on the open app, with an empty env — nothing has been admitted
 * when it runs.
 *
 * The server-level half (that these answer above admission, so a caller
 * admission would refuse still reaches its own check) is the route-answer
 * snapshot's rows for these paths.
 */
import { describe, expect, it } from 'bun:test';
import type { HonoOpenAppEnv } from '../src/hono-env.ts';
import { createHonoFront } from '../src/routes/hono-front.ts';
import {
  type HonoOpenFamiliesContext,
  honoOpenFamilies,
} from '../src/routes/hono-open-families.ts';

const j = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A loopback caller, a board named Harborlight, and no board import. */
const ctx = {
  homeFeedCtx: {
    j,
    peerAddress: () => '127.0.0.1',
    verifier: null,
    clientId: undefined,
    boardName: (id: string) => (id === 'w-1' ? 'Harborlight' : undefined),
    feed: async (id: string) => ({ board: id, items: [] }),
  },
  boardImportCtx: undefined,
  githubHubCtx: { j },
} as unknown as HonoOpenFamiliesContext;

const at = (path: string, init: RequestInit = {}) => new Request(`http://localhost${path}`, init);

describe('honoOpenFamilies', () => {
  const open = createHonoFront<HonoOpenAppEnv>(honoOpenFamilies(ctx), { upgrades: 'enter' });

  it('answers a board’s home feed with no admission behind it', async () => {
    const res = await open(at('/workspaces/w-1/home-feed'), {});
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ board: 'w-1', items: [] });
    expect((await open(at('/workspaces/w-2/home-feed'), {}))?.status).toBe(404);
    expect((await open(at('/workspaces/w-1/home-feed', { method: 'POST' }), {}))?.status).toBe(405);
  });

  it('hands back a board import the server was built without', async () => {
    // The family claims the path and its handler declines: a miss, as in
    // the chain.
    expect(await open(at('/api/board-import/w-1'), {})).toBeNull();
  });

  it('hands back every address outside its three families', async () => {
    for (const path of ['/', '/workspaces/w-1', '/workspaces/w-1/home-feedx', '/api/github']) {
      expect(await open(at(path), {})).toBeNull();
    }
  });
});
