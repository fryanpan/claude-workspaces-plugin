/**
 * `honoBoardFamilies` on its own: the workspace scope and the board run
 * mounted on a Hono app, with stub contexts that reach only a handler's first
 * answer.
 *
 * What the whole server answers at every route-table address is
 * `route-answers.test.ts`; this file holds the properties that table reads
 * only indirectly — the scope runs before any family and its refusal is the
 * answer, the meetings are tried before the doc resource catch-all, an
 * address outside every board pattern is handed back, and an upgrade that
 * reached the board app is let in.
 */
import { describe, expect, it } from 'bun:test';
import type { HonoBoardAppEnv, HonoBoardEnv } from '../src/hono-env.ts';
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

/**
 * A context every family would throw on, except the meetings. Board `w-1`
 * exists and holds every row; no other board exists.
 */
const ctxWith = (holders: readonly string[]) =>
  ({
    meetingCalendarRoutesCtx: { j, isValidDocId: () => false, meetingRelay: {} },
    workspaceRecord: (id: string) => (id === 'w-1' ? { id } : undefined),
    workspacesOfMember: () => holders,
    j,
    requireSignInToWrite: false,
    policyFor: () => ({ requestOrigin: undefined }),
  }) as unknown as HonoBoardFamiliesContext;

const env = {
  gate: { visitor: null },
  attribution: {
    authorFor: () => null,
    provenIdentityFor: () => null,
    browserProvedNobody: () => true,
  },
  ownerProven: () => false,
  mayMintAppVoice: () => false,
} as unknown as HonoBoardEnv;

const at = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers ?? {}) },
  });

/** The scope, then the last two families: the meetings and the doc resource. */
function scopeAndLastTwo(holders: readonly string[], upgrades: 'skip' | 'enter' = 'enter') {
  const families = honoBoardFamilies(ctxWith(holders));
  const [scope] = families;
  if (!scope) throw new Error('no scope middleware');
  return createHonoFront<HonoBoardAppEnv>([scope, ...families.slice(-2)], { upgrades });
}

describe('honoBoardFamilies', () => {
  it('tries a doc’s meetings before the doc resource catch-all', async () => {
    // `docs/<id>/meetings` matches the doc resource pattern too. The meetings
    // answer it first; the doc resource family, whose context is empty here,
    // would throw if it were tried.
    const front = scopeAndLastTwo(['w-1']);
    const res = await front(at('/workspaces/w-1/docs/bad/meetings'), env);
    expect(res?.status).toBe(400);
    expect(await res?.json()).toEqual({ error: 'bad docId' });
  });

  it('answers with the scope’s refusal before any family runs', async () => {
    // The same address, on a board that does not exist and on a board that
    // does not hold the doc. Had the meetings run, either would read 400.
    const missingBoard = await scopeAndLastTwo(['w-1'])(
      at('/workspaces/w-2/docs/bad/meetings'),
      env,
    );
    expect(missingBoard?.status).toBe(404);
    const elsewhere = await scopeAndLastTwo(['w-9'])(at('/workspaces/w-1/docs/bad/meetings'), env);
    expect(elsewhere?.status).toBe(404);
  });

  it('reaches the meetings’ paths outside the board', async () => {
    const res = await scopeAndLastTwo([])(at('/api/meeting-engines', { method: 'POST' }), env);
    expect(res?.status).toBe(405);
  });

  it('hands back null for addresses outside every board pattern', async () => {
    // The whole app: the scope passes each, no family's pattern matches, so
    // none is called.
    const whole = createHonoFront<HonoBoardAppEnv>(honoBoardFamilies(ctxWith([])));
    for (const path of ['/api/docs', '/api/calendarx', '/api/meeting-engines/x', '/s/a', '/']) {
      expect(await whole(at(path), env)).toBeNull();
    }
  });

  it('lets in an upgrade that reached it, which the front would hand back', async () => {
    const upgrade = { headers: { upgrade: 'websocket', connection: 'Upgrade' } };
    const path = '/workspaces/w-1/docs/bad/meetings';
    expect((await scopeAndLastTwo(['w-1'], 'enter')(at(path, upgrade), env))?.status).toBe(400);
    expect(await scopeAndLastTwo(['w-1'], 'skip')(at(path, upgrade), env)).toBeNull();
  });
});
