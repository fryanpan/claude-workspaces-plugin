/**
 * Every page type raises when it loads slowly, and says which page it was.
 *
 * Until 19 Oct 2026 only the board's task list was judged: the review page
 * took 5-10s on a phone and nothing raised. These drive both routes a report
 * can arrive by — a board's own, for the board and the pages filed on it, and
 * `/api/load-reports` for Home and the review page — with an alarm that
 * records what it raised instead of reaching Sentry.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PageLoadLog } from '../src/page-loads.ts';
import { handleLoadReportRoutes } from '../src/routes/load-reports.ts';
import { handleWorkspaceNext } from '../src/routes/workspace-next.ts';
import type {
  WorkspaceRouteRequest,
  WorkspaceRoutesContext,
} from '../src/routes/workspace-routes-context.ts';
import { PAGE_LOAD_BUDGET_MS, SlowLoadAlarm } from '../src/slow-load-alarm.ts';

const T0 = 1_800_000_000_000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Raised = { message: string; extra: Record<string, string> };

/** A server-shaped pair of collaborators: one alarm, one log, one data dir. */
function rig(clock = { now: T0 }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'page-load-alarm-'));
  dirs.push(dataDir);
  const raised: Raised[] = [];
  const slowLoadAlarm = new SlowLoadAlarm((message, extra) => raised.push({ message, extra }));
  const pageLoads = new PageLoadLog(dataDir);
  const j = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });

  /** POST through the board's own route, `/workspaces/w-1/load-reports`. */
  async function postToBoard(body: unknown): Promise<number> {
    const ctx = {
      dataDir,
      slowLoadAlarm,
      pageLoads,
      j,
      safeJson: async () => body,
    } as unknown as WorkspaceRoutesContext;
    const pathname = '/workspaces/w-1/load-reports';
    const res = await handleWorkspaceNext(ctx, {
      req: new Request(`http://localhost${pathname}`, { method: 'POST' }),
      pathname,
      url: new URL(`http://localhost${pathname}`),
    } as unknown as WorkspaceRouteRequest);
    return res?.status ?? 0;
  }

  /** POST through the route for pages on no board, `/api/load-reports`. */
  async function postBoardless(body: unknown, visitor = false): Promise<number> {
    const res = await handleLoadReportRoutes(
      {
        pageLoads,
        slowLoadAlarm,
        j,
        safeJson: async () => body as Record<string, unknown>,
        requestAddress: () => '127.0.0.1',
        now: () => clock.now,
      },
      {
        req: new Request('http://localhost/api/load-reports', { method: 'POST' }),
        pathname: '/api/load-reports',
        visitor: visitor ? ({ kind: 'workspace', workspaceId: 'w-1' } as never) : null,
      },
    );
    return res?.status ?? 0;
  }

  return { raised, pageLoads, postToBoard, postBoardless };
}

const SLOW = PAGE_LOAD_BUDGET_MS + 3_260;

describe('a slow load on a board page raises once, naming its page type', () => {
  for (const page of ['board', 'doc', 'mock', 'diff', 'folder'] as const) {
    it(`${page}`, async () => {
      const { raised, postToBoard } = rig();
      // A fast one first: the positive control that the route reaches the
      // alarm at all, and that it does not raise on every report.
      expect(await postToBoard({ page, msToBoot: 200, msToContent: 900 })).toBe(200);
      expect(raised).toHaveLength(0);
      expect(await postToBoard({ page, msToBoot: 400, msToContent: SLOW })).toBe(200);
      // A reload inside the cooldown is the same incident.
      expect(await postToBoard({ page, msToBoot: 400, msToContent: SLOW })).toBe(200);
      expect(raised).toHaveLength(1);
      expect(raised[0]?.message).toStartWith(`${page} page on board w-1:`);
      expect(raised[0]?.message).toContain(String(SLOW));
      expect(raised[0]?.extra).toMatchObject({
        page,
        workspaceId: 'w-1',
        reason: 'over-budget',
        msToContent: String(SLOW),
      });
    });
  }
});

describe('a slow load on a page with no board raises once, naming its page type', () => {
  for (const page of ['home', 'review'] as const) {
    it(`${page}`, async () => {
      const { raised, postBoardless } = rig();
      expect(await postBoardless({ page, msToBoot: 200, msToContent: 700 })).toBe(200);
      expect(raised).toHaveLength(0);
      expect(await postBoardless({ page, msToBoot: 300, msToContent: SLOW })).toBe(200);
      expect(await postBoardless({ page, msToBoot: 300, msToContent: SLOW })).toBe(200);
      expect(raised).toHaveLength(1);
      expect(raised[0]?.message).toStartWith(`${page} page:`);
      expect(raised[0]?.extra).toMatchObject({ page, reason: 'over-budget' });
      expect(raised[0]?.extra.workspaceId).toBeUndefined();
    });
  }
});

describe('content that never arrives', () => {
  it('raises on every page type, as the worst case rather than as no reading', async () => {
    const { raised, postToBoard, postBoardless } = rig();
    for (const page of ['board', 'doc', 'mock', 'diff', 'folder'] as const) {
      await postToBoard({ page, msToBoot: 500 });
    }
    for (const page of ['home', 'review'] as const) await postBoardless({ page, msToBoot: 500 });
    expect(raised.map((r) => r.extra.page)).toEqual([
      'board',
      'doc',
      'mock',
      'diff',
      'folder',
      'home',
      'review',
    ]);
    expect(raised.every((r) => r.extra.reason === 'never-arrived')).toBe(true);
    expect(raised[1]?.message).toBe(
      'doc page on board w-1: the doc text never arrived before the client gave up',
    );
  });
});

describe('the cooldown', () => {
  it('is held per page type, so a slow board never silences a slow doc on it', async () => {
    const { raised, postToBoard } = rig();
    await postToBoard({ page: 'board', msToBoot: 400, msToContent: SLOW });
    await postToBoard({ page: 'doc', msToBoot: 400, msToContent: SLOW });
    expect(raised.map((r) => r.extra.page)).toEqual(['board', 'doc']);
  });

  it("still judges a board client's report from before page types", async () => {
    // Open tabs keep the bundle they loaded: their report names no page and
    // stamps the projection rather than msToContent.
    const { raised, postToBoard } = rig();
    expect(await postToBoard({ msToBoot: 400, msToFirstProjection: SLOW })).toBe(200);
    expect(raised[0]?.extra).toMatchObject({ page: 'board', msToContent: String(SLOW) });
  });
});

describe('what each route refuses', () => {
  it('a board route refuses a page that is on no board', async () => {
    const { raised, postToBoard } = rig();
    expect(await postToBoard({ page: 'review', msToBoot: 1, msToContent: SLOW })).toBe(400);
    expect(raised).toHaveLength(0);
  });

  it('the boardless route refuses a board page, an unknown page and a share visitor', async () => {
    const { raised, postBoardless } = rig();
    expect(await postBoardless({ page: 'doc', msToBoot: 1, msToContent: SLOW })).toBe(400);
    expect(await postBoardless({ page: 'settings', msToBoot: 1, msToContent: SLOW })).toBe(400);
    expect(await postBoardless({ msToBoot: 1, msToContent: SLOW })).toBe(400);
    expect(await postBoardless({ page: 'home', msToBoot: 1, nested: { a: 1 } })).toBe(400);
    expect(await postBoardless({ page: 'home', msToBoot: 1, msToContent: SLOW }, true)).toBe(403);
    expect(raised).toHaveLength(0);
  });
});
