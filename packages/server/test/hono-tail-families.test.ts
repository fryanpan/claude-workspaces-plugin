/**
 * `honoTailFamilies` on its own: the tail on the board app, with stub
 * features and a stub shell.
 *
 * Every tail family claims `*`, so registration order is the only thing that
 * orders them. This file holds that order where it decides an answer —
 * a feature before the shell, the shell before the task address — and that
 * an address all of them decline is handed back for the chain's bare 404.
 */
import { describe, expect, it } from 'bun:test';
import type { HonoBoardAppEnv, HonoBoardEnv } from '../src/hono-env.ts';
import { createHonoFront } from '../src/routes/hono-front.ts';
import {
  type HonoTailFamiliesContext,
  honoTailFamilies,
} from '../src/routes/hono-tail-families.ts';

const text = (body: string) => new Response(body, { status: 200 });

const ctx = {
  // The feature claims `/both` only; the shell claims `/both` and `/shell`.
  featureRoutes: async ({ pathname }: { pathname: string }) =>
    pathname === '/both' ? text('feature') : null,
  serveShellRoutes: async ({ pathname }: { pathname: string }) =>
    pathname === '/both' || pathname === '/shell' ? text('shell') : null,
  boardLinkRoutesCtx: {},
  requireSignInToWrite: false,
  policyFor: () => ({ requestOrigin: undefined }),
} as unknown as HonoTailFamiliesContext;

const env = {
  gate: { visitor: null, visitorHome: null, requireOwner: () => null },
  attribution: {
    authorFor: () => null,
    provenIdentityFor: () => null,
    browserProvedNobody: () => true,
  },
  ownerProven: () => false,
  mayMintAppVoice: () => false,
} as unknown as HonoBoardEnv;

const at = (path: string) => new Request(`http://localhost${path}`);

describe('honoTailFamilies', () => {
  const tail = createHonoFront<HonoBoardAppEnv>(honoTailFamilies(ctx), { upgrades: 'enter' });

  it('tries a registered feature before the shell', async () => {
    expect(await (await tail(at('/both'), env))?.text()).toBe('feature');
    expect(await (await tail(at('/shell'), env))?.text()).toBe('shell');
  });

  it('reaches the task address once the shell declines', async () => {
    const res = await tail(at('/workspaces/w-1/tasks/t-1'), env);
    expect(res?.status).toBeGreaterThanOrEqual(300);
    expect(res?.status).toBeLessThan(400);
    expect(res?.headers.get('location')).toContain('t-1');
  });

  it('hands back an address every tail family declines', async () => {
    expect(await tail(at('/nothing-serves-this'), env)).toBeNull();
  });
});
