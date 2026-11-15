/**
 * `honoBoardFamilies` on its own: the board run mounted on a Hono app, with
 * stub contexts that reach only a handler's first answer.
 *
 * What the whole server answers at every route-table address is
 * `route-answers.test.ts`; this file holds the two properties that table
 * reads only indirectly — the meetings are tried before the doc resource
 * catch-all, and an address outside every board pattern is handed back.
 */
import { describe, expect, it } from 'bun:test';
import type { HonoBoardEnv } from '../src/hono-env.ts';
import {
  type HonoBoardFamiliesContext,
  honoBoardFamilies,
} from '../src/routes/hono-board-families.ts';
import { createHonoFront } from '../src/routes/hono-front.ts';

const j = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A context every family would throw on, except the meetings. */
const ctx = {
  meetingCalendarRoutesCtx: { j, isValidDocId: () => false, meetingRelay: {} },
  requireSignInToWrite: false,
  policyFor: () => ({ requestOrigin: undefined }),
} as unknown as HonoBoardFamiliesContext;

const envFor = (rest?: string) =>
  ({
    gate: { visitor: null },
    attribution: {
      authorFor: () => null,
      provenIdentityFor: () => null,
      browserProvedNobody: () => true,
    },
    ownerProven: () => false,
    scope: rest === undefined ? undefined : { workspaceId: 'w-1', rest, board: {} },
    mayMintAppVoice: () => false,
  }) as unknown as HonoBoardEnv;

const at = (path: string, init: RequestInit = {}) => new Request(`http://localhost${path}`, init);

describe('honoBoardFamilies', () => {
  // The last two families are the meetings and the doc resource catch-all.
  // The composites above them claim every board address and would need a
  // full context each; the order between these two is what this file tests.
  const families = honoBoardFamilies(ctx);
  const front = createHonoFront<HonoBoardEnv>(families.slice(-2));
  const whole = createHonoFront<HonoBoardEnv>(families);

  it('tries a doc’s meetings before the doc resource catch-all', async () => {
    // `docs/<id>/meetings` matches the doc resource pattern too. The meetings
    // answer it first; the doc resource family, whose context is empty here,
    // would throw if it were tried.
    const res = await front(at('/workspaces/w-1/docs/bad/meetings'), envFor('docs/bad/meetings'));
    expect(res?.status).toBe(400);
    expect(await res?.json()).toEqual({ error: 'bad docId' });
  });

  it('reaches the meetings’ paths outside the board', async () => {
    const res = await front(at('/api/meeting-engines', { method: 'POST' }), envFor());
    expect(res?.status).toBe(405);
  });

  it('hands back null for addresses outside every board pattern', async () => {
    // The whole app: no family's pattern matches, so none is called.
    for (const path of ['/api/docs', '/api/calendarx', '/api/meeting-engines/x', '/s/a', '/']) {
      expect(await whole(at(path), envFor())).toBeNull();
    }
  });
});
