/**
 * A count nobody has refreshed is not a zero.
 *
 * The daily chat audit's launchd job failed every day for three weeks in
 * 2026, and a session asking for its own unfiled-ask count got `today: null`
 * back and read it as a clean sheet. The read now says which of the three it
 * is — a fresh count, a stale one, or none at all — and `couldNotLook` is the
 * single field a caller has to check.
 *
 * Driven with a nineteen-day-old row, the age the outage actually reached.
 * Each case carries its control: the same store, the same agent, a row inside
 * the window.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIT_STALE_AFTER_MS, ChatAudit, chatAuditLogPath, localDay } from '../src/chat-audit.ts';
import { createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-09-15T18:00:00.000Z');

describe('the unfiled-ask count says how fresh it is', () => {
  const dirs: string[] = [];
  let dir = '';
  const temp = (prefix: string): string => {
    dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    dir = '';
  });

  /** A store whose clock the test owns, with one row published `daysAgo`. */
  function storeWithRow(daysAgo: number, unfiledAsks: number): ChatAudit {
    temp('chat-audit-stale-');
    const publishedAt = NOW - daysAgo * DAY_MS;
    let clock = publishedAt;
    const store = new ChatAudit({ dataDir: dir, now: () => clock });
    store.publish({
      day: localDay(publishedAt),
      auditor: 'Team Lead',
      entries: [{ agent: 'Millwright', unfiledAsks }],
    });
    clock = NOW;
    return store;
  }

  it('a nineteen-day-old record reads as could-not-look, never as a fresh zero', () => {
    const read = storeWithRow(19, 0).readFor('Millwright', localDay(NOW));
    expect(read.coverage).toBe('stale');
    expect(read.couldNotLook).toBe(true);
    expect(read.today).toBeNull();
    // The old fields still answer, so the row itself is not hidden.
    expect(read.latest?.unfiledAsks).toBe(0);
    expect(read.latestAgeMs).toBeGreaterThan(AUDIT_STALE_AFTER_MS);
    expect(read.staleAfterMs).toBe(AUDIT_STALE_AFTER_MS);
  });

  it('control: a row published this morning reads as current', () => {
    const read = storeWithRow(0, 2).readFor('Millwright', localDay(NOW));
    expect(read.coverage).toBe('current');
    expect(read.couldNotLook).toBe(false);
    expect(read.latest?.unfiledAsks).toBe(2);
  });

  it('an agent nobody has ever audited is could-not-look too, under its own word', () => {
    const read = storeWithRow(0, 2).readFor('Cartographer', localDay(NOW));
    expect(read.coverage).toBe('none');
    expect(read.couldNotLook).toBe(true);
    expect(read.latest).toBeNull();
    expect(read.latestAgeMs).toBeUndefined();
  });

  it('the window is where the verdict turns, not the calendar day', () => {
    // Inside the window by an hour, and outside it by an hour, on either side
    // of the same forty-eight hours.
    const inside = new ChatAudit({
      dataDir: temp('chat-audit-edge-'),
      now: () => NOW - AUDIT_STALE_AFTER_MS + 3_600_000,
    });
    inside.publish({ entries: [{ agent: 'Millwright', unfiledAsks: 1 }] });
    const readInside = new ChatAudit({ dataDir: dir, now: () => NOW }).readFor(
      'Millwright',
      localDay(NOW),
    );
    expect(readInside.coverage).toBe('current');

    const outside = new ChatAudit({
      dataDir: temp('chat-audit-edge2-'),
      now: () => NOW - AUDIT_STALE_AFTER_MS - 3_600_000,
    });
    outside.publish({ entries: [{ agent: 'Millwright', unfiledAsks: 1 }] });
    const readOutside = new ChatAudit({ dataDir: dir, now: () => NOW }).readFor(
      'Millwright',
      localDay(NOW),
    );
    expect(readOutside.coverage).toBe('stale');
  });

  it('the route a session actually calls answers with the could-not-look state', async () => {
    const dataDir = temp('chat-audit-route-');
    // A row on disk dated nineteen days back — the shape the dead audit left
    // behind, written before the server reads the log at boot.
    const publishedAt = NOW - 19 * DAY_MS;
    writeFileSync(
      chatAuditLogPath(dataDir),
      `${JSON.stringify({
        ts: new Date(publishedAt).toISOString(),
        day: localDay(publishedAt),
        auditor: 'Team Lead',
        agent: 'Millwright',
        unfiledAsks: 0,
        totalAsks: 0,
      })}\n`,
    );
    const handle = createServer({ port: 0, dataDir });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const ws = await seedBoard(base);
      const res = await fetch(`${base}/workspaces/${ws}/chat-audit/Millwright`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.coverage).toBe('stale');
      expect(body.couldNotLook).toBe(true);
      // The fields callers read today are still there.
      expect(body).toHaveProperty('today');
      expect(body).toHaveProperty('latest');
      expect(body.agent).toBe('Millwright');

      // Control, same server and same route: an agent the live judge has just
      // recorded reads as current.
      handle.chatAudit.recordLive({ agent: 'Cartographer', unfiled: true });
      const fresh = (await (
        await fetch(`${base}/workspaces/${ws}/chat-audit/Cartographer`)
      ).json()) as Record<string, unknown>;
      expect(fresh.coverage).toBe('current');
      expect(fresh.couldNotLook).toBe(false);
    } finally {
      await handle.stop();
    }
  }, 30_000);
});
