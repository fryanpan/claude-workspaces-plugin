/**
 * Chat-audit counters — the store, and the routes in front of it.
 *
 * Two writers, one log. The daily chat audit — an agent that mines whole
 * transcripts — publishes per-agent counts. The Stop hook route ALSO writes
 * here, one row per detected ask, because the server does see one line of
 * chat: the closing message every turn posts to its Activity tab. The live
 * writer is a floor (a regex over one line); the daily one sees more and its
 * row for a day supersedes. A session reads back whichever row is latest.
 *
 * Store tests cover parsing/latest-wins/persistence; route tests cover the
 * layer a unit test misses. Absence assertions sit next to their positive
 * controls. Fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatAudit, chatAuditLogPath, dayBefore, normalizeAgent } from '../src/chat-audit.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('the live writer — one row per ask the Stop hook route saw', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A store whose clock the test owns, so "the same day" is a fact and not
   *  a race against midnight. */
  function storeAt(iso: string): { store: ChatAudit; set: (iso: string) => void } {
    dir = mkdtempSync(join(tmpdir(), 'chat-audit-live-'));
    let t = Date.parse(iso);
    return {
      store: new ChatAudit({ dataDir: dir, now: () => t }),
      set: (v) => {
        t = Date.parse(v);
      },
    };
  }

  it("carries the day's running totals forward, so each row is the total so far", () => {
    const { store, set } = storeAt('2026-09-10T09:00:00.000Z');
    expect(store.recordLive({ agent: 'Riverbend', unfiled: true })).toMatchObject({
      unfiledAsks: 1,
      totalAsks: 1,
    });
    set('2026-09-10T11:00:00.000Z');
    expect(store.recordLive({ agent: 'Riverbend', unfiled: false })).toMatchObject({
      unfiledAsks: 1,
      totalAsks: 2,
    });
    set('2026-09-10T13:00:00.000Z');
    const third = store.recordLive({ agent: 'Riverbend', unfiled: true });
    expect(third).toMatchObject({ unfiledAsks: 2, totalAsks: 3, auditor: 'stop-hook' });
    // A different agent on the same day counts separately — the forward-carry
    // is per agent, and a shared counter would blame whoever posted last.
    expect(store.recordLive({ agent: 'Harborlight', unfiled: true })).toMatchObject({
      unfiledAsks: 1,
      totalAsks: 1,
    });
  });

  it('starts each day from zero rather than from yesterday', () => {
    const { store, set } = storeAt('2026-09-09T09:00:00.000Z');
    store.recordLive({ agent: 'Riverbend', unfiled: true });
    store.recordLive({ agent: 'Riverbend', unfiled: true });
    set('2026-09-10T09:00:00.000Z');
    expect(store.recordLive({ agent: 'Riverbend', unfiled: true })).toMatchObject({
      unfiledAsks: 1,
      totalAsks: 1,
    });
  });

  it('refuses a row for the bare shared name, which belongs to nobody', () => {
    const { store } = storeAt('2026-09-10T09:00:00.000Z');
    expect(store.recordLive({ agent: 'agent', unfiled: true })).toBeNull();
    expect(store.recordLive({ agent: '  ', unfiled: true })).toBeNull();
  });
});

describe('the window a board surface reads', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** The clock moves between publishes on purpose: a correction is a LATER
   *  row for the same day, and a frozen clock would make the two rows
   *  indistinguishable — which is exactly the case latest-wins exists for. */
  let clock = 0;
  const tick = () => {
    clock += 60_000;
    return clock;
  };

  function seeded(): ChatAudit {
    dir = mkdtempSync(join(tmpdir(), 'chat-audit-window-'));
    clock = Date.parse('2026-09-10T09:00:00.000Z');
    const store = new ChatAudit({ dataDir: dir, now: tick });
    store.publish({
      day: '2026-09-10',
      auditor: 'Team Lead',
      entries: [{ agent: 'Riverbend', unfiledAsks: 4, totalAsks: 9 }],
    });
    store.publish({
      day: '2026-09-08',
      auditor: 'Team Lead',
      entries: [
        { agent: 'Riverbend', unfiledAsks: 1, totalAsks: 2 },
        { agent: 'Wayfarer', unfiledAsks: 7, totalAsks: 7 },
      ],
    });
    store.publish({
      day: '2026-09-02',
      auditor: 'Team Lead',
      entries: [{ agent: 'Riverbend', unfiledAsks: 99, totalAsks: 99 }],
    });
    return store;
  }

  it('sums each agent over the window, worst first, and leaves older days out', () => {
    const view = seeded().window(7, '2026-09-10');
    expect(view).toMatchObject({ days: 7, from: '2026-09-04' });
    // Worst first, which is not alphabetical here — the surface names a few
    // agents and drops the rest, so the order decides who gets named.
    expect(view.agents).toEqual([
      { agent: 'Wayfarer', unfiledAsks: 7, totalAsks: 7, days: 1 },
      { agent: 'Riverbend', unfiledAsks: 5, totalAsks: 11, days: 2 },
    ]);
  });

  it('counts a corrected day once, taking the later row', () => {
    const store = seeded();
    store.publish({
      day: '2026-09-10',
      auditor: 'Team Lead',
      entries: [{ agent: 'Riverbend', unfiledAsks: 0, totalAsks: 9 }],
    });
    const riverbend = store.window(7, '2026-09-10').agents.find((a) => a.agent === 'Riverbend');
    expect(riverbend).toEqual({ agent: 'Riverbend', unfiledAsks: 1, totalAsks: 11, days: 2 });
  });

  it('walks back over a month boundary', () => {
    expect(dayBefore('2026-09-10', 6)).toBe('2026-09-04');
    expect(dayBefore('2026-09-01', 1)).toBe('2026-08-31');
    expect(dayBefore('2026-01-01', 1)).toBe('2025-12-31');
    expect(dayBefore('2026-03-01', 1)).toBe('2026-02-28');
  });
});

describe('ChatAudit store', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('publishes entries and reads the latest row back per agent', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-audit-'));
    let t = Date.parse('2026-08-25T10:00:00.000Z');
    const store = new ChatAudit({ dataDir: dir, now: () => t });
    const first = store.publish({
      day: '2026-08-24',
      auditor: 'Team Lead',
      entries: [
        { agent: 'Alpha Agent', unfiledAsks: 3, totalAsks: 5 },
        { agent: 'Beta Agent', unfiledAsks: 0 },
      ],
    });
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0]?.day).toBe('2026-08-24');

    // A later publish for the same agent supersedes — latest wins, and the
    // earlier row stays on disk (append-only; corrections are new rows).
    t += 60_000;
    store.publish({
      day: '2026-08-25',
      auditor: 'Team Lead',
      entries: [{ agent: 'alpha agent', unfiledAsks: 1, note: 'one ask at 09:12' }],
    });

    const read = store.readFor('Alpha Agent', '2026-08-25');
    expect(read.latest?.unfiledAsks).toBe(1);
    expect(read.latest?.day).toBe('2026-08-25');
    expect(read.today?.unfiledAsks).toBe(1);
    // Positive control for the day filter: on a day with no row, `today` is
    // null while `latest` still answers.
    const stale = store.readFor('Beta Agent', '2026-08-25');
    expect(stale.today).toBeNull();
    expect(stale.latest?.unfiledAsks).toBe(0);
  });

  it('matches agents case- and whitespace-insensitively', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-audit-'));
    const store = new ChatAudit({ dataDir: dir });
    store.publish({ entries: [{ agent: '  Live Feedback ', unfiledAsks: 2 }] });
    expect(store.readFor('live feedback', '2000-01-01').latest?.unfiledAsks).toBe(2);
    // Positive control: a different name still reads nothing.
    expect(store.readFor('other agent', '2000-01-01').latest).toBeNull();
    expect(normalizeAgent('  Live Feedback ')).toBe('live feedback');
  });

  it('survives a new instance over the same data dir, skipping corrupt lines', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-audit-'));
    new ChatAudit({ dataDir: dir }).publish({
      day: '2026-08-24',
      entries: [{ agent: 'Alpha', unfiledAsks: 4 }],
    });
    appendFileSync(chatAuditLogPath(dir), 'not json\n');
    const again = new ChatAudit({ dataDir: dir });
    expect(again.readFor('Alpha', '2026-08-24').today?.unfiledAsks).toBe(4);
    expect(again.loadError).toContain('skipped');
  });

  it('refuses invalid entries: shared identity, negative or non-integer counts, bad day', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-audit-'));
    const store = new ChatAudit({ dataDir: dir });
    expect(() => store.publish({ entries: [{ agent: 'agent', unfiledAsks: 1 }] })).toThrow(
      /shared identity/i,
    );
    expect(() => store.publish({ entries: [{ agent: 'Alpha', unfiledAsks: -1 }] })).toThrow();
    expect(() => store.publish({ entries: [{ agent: 'Alpha', unfiledAsks: 1.5 }] })).toThrow();
    expect(() =>
      store.publish({ day: 'yesterday', entries: [{ agent: 'Alpha', unfiledAsks: 1 }] }),
    ).toThrow(/day/);
    expect(() => store.publish({ entries: [] })).toThrow(/entries/);
    // Nothing landed on disk from the refusals.
    expect(store.latestPerAgent()).toEqual([]);
  });

  it('latestPerAgent lists one row per agent, the newest', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-audit-'));
    let t = 1_000_000_000_000;
    const store = new ChatAudit({ dataDir: dir, now: () => t });
    store.publish({ day: '2026-08-23', entries: [{ agent: 'Alpha', unfiledAsks: 5 }] });
    t += 1000;
    store.publish({
      day: '2026-08-24',
      entries: [
        { agent: 'Alpha', unfiledAsks: 2 },
        { agent: 'Beta', unfiledAsks: 1 },
      ],
    });
    const rows = store.latestPerAgent();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.agent === 'Alpha')?.unfiledAsks).toBe(2);
    expect(rows.find((r) => r.agent === 'Beta')?.unfiledAsks).toBe(1);
  });
});

describe(`/workspaces/${WS}/chat-audit routes`, () => {
  let handle: ServerHandle | null = null;
  let dataDir: string | null = null;

  const start = async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'chat-audit-route-'));
    handle = createServer({ port: 0, dataDir });
    WS = await seedBoard(`http://127.0.0.1:${handle.port}`);
    return `http://127.0.0.1:${handle.port}`;
  };

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  const call = async (base: string, path: string, method: 'GET' | 'POST', body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        host: `localhost:${handle?.port ?? 0}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('a session reads its own number back: null before any audit, the count after', async () => {
    const base = await start();

    // Before any publish: a real answer, not an error — and explicitly null.
    const before = await call(base, `/workspaces/${WS}/chat-audit/Alpha%20Agent`, 'GET');
    expect(before.status).toBe(200);
    expect(before.json.latest).toBeNull();
    expect(before.json.today).toBeNull();
    expect(typeof before.json.day).toBe('string');

    const day = before.json.day as string;
    const post = await call(base, `/workspaces/${WS}/chat-audit`, 'POST', {
      day,
      auditor: 'Team Lead',
      entries: [{ agent: 'Alpha Agent', unfiledAsks: 3, note: 'two asks in chat, one filed' }],
    });
    expect(post.status).toBe(200);
    expect((post.json.rows as Array<{ unfiledAsks: number }>)[0]?.unfiledAsks).toBe(3);

    // The positive control for `before`: the same probe now sees the number.
    const after = await call(base, `/workspaces/${WS}/chat-audit/Alpha%20Agent`, 'GET');
    expect(after.status).toBe(200);
    expect((after.json.today as { unfiledAsks: number }).unfiledAsks).toBe(3);
    expect((after.json.latest as { auditor?: string }).auditor).toBe('Team Lead');

    // A different agent still reads null — counts are per agent.
    const other = await call(base, `/workspaces/${WS}/chat-audit/Beta%20Agent`, 'GET');
    expect(other.json.latest).toBeNull();
  });

  it('lists the latest row per agent for the audit to reference', async () => {
    const base = await start();
    await call(base, `/workspaces/${WS}/chat-audit`, 'POST', {
      entries: [
        { agent: 'Alpha', unfiledAsks: 2 },
        { agent: 'Beta', unfiledAsks: 0 },
      ],
    });
    const list = await call(base, `/workspaces/${WS}/chat-audit`, 'GET');
    expect(list.status).toBe(200);
    expect(list.json.rows as unknown[]).toHaveLength(2);
  });

  it('refuses a bad publish with a 400 that names the problem', async () => {
    const base = await start();
    const noEntries = await call(base, `/workspaces/${WS}/chat-audit`, 'POST', { entries: [] });
    expect(noEntries.status).toBe(400);
    const shared = await call(base, `/workspaces/${WS}/chat-audit`, 'POST', {
      entries: [{ agent: 'agent', unfiledAsks: 1 }],
    });
    expect(shared.status).toBe(400);
    const sharedRead = await call(base, `/workspaces/${WS}/chat-audit/agent`, 'GET');
    expect(sharedRead.status).toBe(400);
  });
});
