/**
 * The board says it was slow while somebody can still do something about it.
 *
 * The load-report log has recorded every board boot for weeks; a 3.7x
 * regression sat in it for eleven days and was found by a complaint. What
 * these drive is the judgement that turns a logged reading into a raised one:
 * the budget, the load that never synced at all, and the cooldown that keeps
 * one slow board from being one alarm per tab.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleWorkspaceNext } from '../src/routes/workspace-next.ts';
import type {
  WorkspaceRouteRequest,
  WorkspaceRoutesContext,
} from '../src/routes/workspace-routes-context.ts';
import {
  ALARM_COOLDOWN_MS,
  LIST_PAINT_BUDGET_MS,
  SlowLoadAlarm,
  slowLoadVerdict,
} from '../src/slow-load-alarm.ts';

const T0 = 1_800_000_000_000;

/** An alarm that records what it raised instead of reaching Sentry. */
function alarm(cooldownMs = ALARM_COOLDOWN_MS) {
  const raised: Array<{ message: string; extra: Record<string, string> }> = [];
  const it = new SlowLoadAlarm((message, extra) => raised.push({ message, extra }), cooldownMs);
  return { it, raised };
}

describe('reading one report', () => {
  it('says nothing about a load inside the budget', () => {
    expect(
      slowLoadVerdict({ msToBoot: 300, msToFirstProjection: LIST_PAINT_BUDGET_MS }),
    ).toBeNull();
  });

  it('calls a load over the budget over-budget, and carries the reading', () => {
    const verdict = slowLoadVerdict({ msToBoot: 1_065, msToFirstProjection: 5_260 });
    expect(verdict).toEqual({
      reason: 'over-budget',
      msToFirstProjection: 5_260,
      budgetMs: LIST_PAINT_BUDGET_MS,
    });
  });

  it('treats a missing projection stamp as the worst case, not as no reading', () => {
    // The client omits the field when the ydoc never landed before its
    // fallback deadline — two of eight loads on the live board the night the
    // regression was found. Reading that as "nothing to judge" would make the
    // loudest failure the silent one.
    const verdict = slowLoadVerdict({ msToBoot: 901 });
    expect(verdict?.reason).toBe('never-synced');
    expect(verdict?.msToFirstProjection).toBeNull();
  });

  it('judges nothing without a boot stamp', () => {
    expect(slowLoadVerdict({ msToFirstProjection: 9_000 })).toBeNull();
    expect(slowLoadVerdict({ msToBoot: 'soon' })).toBeNull();
  });
});

describe('raising it', () => {
  it('raises once and names the board, the reason and the reading', () => {
    const { it: a, raised } = alarm();
    a.consider('w-1', { msToBoot: 400, msToFirstProjection: 5_260 }, T0);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.message).toContain('w-1');
    expect(raised[0]?.message).toContain('5260');
    expect(raised[0]?.extra).toMatchObject({
      workspaceId: 'w-1',
      reason: 'over-budget',
      msToFirstProjection: '5260',
    });
  });

  it('stays quiet for the rest of the cooldown, then speaks again', () => {
    const { it: a, raised } = alarm();
    const slow = { msToBoot: 400, msToFirstProjection: 9_000 };
    a.consider('w-1', slow, T0);
    a.consider('w-1', slow, T0 + ALARM_COOLDOWN_MS - 1);
    expect(raised).toHaveLength(1);
    a.consider('w-1', slow, T0 + ALARM_COOLDOWN_MS);
    expect(raised).toHaveLength(2);
  });

  it('holds the cooldown per board, so one slow board never silences another', () => {
    const { it: a, raised } = alarm();
    const slow = { msToBoot: 400, msToFirstProjection: 9_000 };
    a.consider('w-1', slow, T0);
    a.consider('w-2', slow, T0);
    expect(raised.map((r) => r.extra.workspaceId)).toEqual(['w-1', 'w-2']);
  });

  it('never raises on a load that met the budget', () => {
    const { it: a, raised } = alarm();
    a.consider('w-1', { msToBoot: 200, msToFirstProjection: 480 }, T0);
    expect(raised).toHaveLength(0);
  });
});

describe('the load-report route raises it', () => {
  /** The POST path, with the collaborators that block reaches and no others. */
  async function postReport(body: unknown, alarm: SlowLoadAlarm): Promise<number> {
    const dataDir = mkdtempSync(join(tmpdir(), 'slow-load-route-'));
    try {
      const ctx = {
        dataDir,
        slowLoadAlarm: alarm,
        j: (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status }),
        safeJson: async () => body,
      } as unknown as WorkspaceRoutesContext;
      const pathname = '/workspaces/w-1/load-reports';
      const res = await handleWorkspaceNext(ctx, {
        req: new Request(`http://localhost${pathname}`, { method: 'POST' }),
        pathname,
        url: new URL(`http://localhost${pathname}`),
      } as unknown as WorkspaceRouteRequest);
      return res?.status ?? 0;
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  it('raises on a slow report, and stays quiet on a fast one', async () => {
    const { it: a, raised } = alarm();
    // The fast one first, as the positive control on the wiring: if the route
    // never called the alarm at all, both halves would read the same.
    expect(await postReport({ msToBoot: 200, msToFirstProjection: 400 }, a)).toBe(200);
    expect(raised).toHaveLength(0);
    expect(await postReport({ msToBoot: 900, msToFirstProjection: 5_260 }, a)).toBe(200);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.extra.workspaceId).toBe('w-1');
  });

  it('never lets a refused report reach the alarm', async () => {
    const { it: a, raised } = alarm();
    // A nested value is what the report shape exists to refuse. Judging it
    // anyway would make the alarm reachable by a body the route would not
    // store.
    expect(await postReport({ msToBoot: 900, nested: { deep: 1 } }, a)).toBe(400);
    expect(raised).toHaveLength(0);
  });
});
