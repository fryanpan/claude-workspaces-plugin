/**
 * The daily health check's read: the slowest load per page type over the
 * last 24 hours, from one loopback-only route.
 *
 * Driven two ways. `PageLoadLog` directly, with an injected clock, for what
 * the read counts and what falls outside its window; and a real server, for
 * the claim that a report posted by either route reaches the read, and that
 * the read refuses the edge and a browser.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAGE_LOAD_WINDOW_MS, PageLoadLog, type SlowestByPage } from '../src/page-loads.ts';
import { handleLoadReportRoutes } from '../src/routes/load-reports.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { PAGE_TYPES, SlowLoadAlarm } from '../src/slow-load-alarm.ts';

const T0 = 1_800_000_000_000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const freshLog = () => {
  const d = mkdtempSync(join(tmpdir(), 'page-loads-'));
  dirs.push(d);
  return new PageLoadLog(d);
};
const freshDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'page-loads-'));
  dirs.push(d);
  return d;
};

describe('the slowest load per page type', () => {
  it('names every page type, the slowest reading, its board and the counts', () => {
    const log = freshLog();
    log.record('w-1', { page: 'doc', msToBoot: 100, msToContent: 900 }, T0);
    log.record('w-2', { page: 'doc', msToBoot: 100, msToContent: 4_100 }, T0 + 1);
    log.record('w-1', { page: 'doc', msToBoot: 100 }, T0 + 2);
    log.record(null, { page: 'review', msToBoot: 100, msToContent: 7_300 }, T0 + 3);
    const read = log.slowestByPage(T0 + 10);
    expect(Object.keys(read.pages).sort()).toEqual([...PAGE_TYPES].sort());
    expect(read.pages.doc).toEqual({
      loads: 3,
      neverArrived: 1,
      overBudget: 2,
      slowestMs: 4_100,
      slowestAt: T0 + 1,
      slowestWorkspaceId: 'w-2',
    });
    expect(read.pages.review.slowestMs).toBe(7_300);
    expect(read.pages.review.slowestWorkspaceId).toBeNull();
    // A page type nobody loaded reads as zero loads, not as absent: zero in a
    // day is itself the finding that its reporting is broken.
    expect(read.pages.mock).toMatchObject({ loads: 0, slowestMs: null });
  });

  it('survives a torn line and a row with no page, which reads as the board', () => {
    const d = freshDir();
    const log = new PageLoadLog(d);
    log.record('w-1', { page: 'doc', msToBoot: 1, msToContent: 300 }, T0);
    appendFileSync(join(d, 'page-loads.jsonl'), `{"ts":${T0 + 1},"ms":2600}\n{"ts":${T0 + 2},"pa`);
    const read = log.slowestByPage(T0 + 10);
    expect(read.pages.doc).toMatchObject({ loads: 1, slowestMs: 300 });
    expect(read.pages.board).toMatchObject({ loads: 1, slowestMs: 2_600 });
  });

  it('reads only the last 24 hours', () => {
    const log = freshLog();
    log.record('w-1', { page: 'board', msToBoot: 1, msToContent: 9_000 }, T0);
    log.record('w-1', { page: 'board', msToBoot: 1, msToContent: 2_500 }, T0 + 60_000);
    const later = log.slowestByPage(T0 + PAGE_LOAD_WINDOW_MS + 1);
    expect(later.pages.board).toMatchObject({ loads: 1, slowestMs: 2_500 });
  });

  it('keeps only reports the alarm can judge', () => {
    const log = freshLog();
    log.record('w-1', { page: 'doc', msToContent: 9_000 }, T0);
    log.record('w-1', { page: 'nonsense', msToBoot: 1, msToContent: 9_000 }, T0);
    expect(log.slowestByPage(T0 + 1).pages.doc.loads).toBe(0);
  });
});

describe('the read refuses anyone off the box', () => {
  it('refuses a non-loopback socket address', async () => {
    const res = await handleLoadReportRoutes(
      {
        pageLoads: freshLog(),
        slowLoadAlarm: new SlowLoadAlarm(() => {}),
        j: (status, body) => new Response(JSON.stringify(body), { status }),
        safeJson: async () => null,
        requestAddress: () => '192.168.4.20',
      },
      {
        req: new Request('http://localhost/api/load-reports/slowest'),
        pathname: '/api/load-reports/slowest',
        visitor: null,
      },
    );
    expect(res?.status).toBe(403);
  });
});

describe('through a real server', () => {
  let handle: ServerHandle;
  let base: string;
  let ws: string;

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'page-loads-server-'));
    dirs.push(dataDir);
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const mk = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harborlight timings' }),
    });
    ws = ((await mk.json()) as { workspace: { id: string } }).workspace.id;
  });
  afterAll(async () => {
    await handle.stop();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('returns the reports both routes took, by page type', async () => {
    expect(
      (
        await post(`/workspaces/${ws}/load-reports`, {
          page: 'mock',
          msToBoot: 50,
          msToContent: 3_400,
        })
      ).status,
    ).toBe(200);
    expect(
      (await post('/api/load-reports', { page: 'home', msToBoot: 40, msToContent: 610 })).status,
    ).toBe(200);
    const res = await fetch(`${base}/api/load-reports/slowest`);
    expect(res.status).toBe(200);
    const read = (await res.json()) as SlowestByPage;
    expect(read.pages.mock).toMatchObject({ loads: 1, slowestMs: 3_400, slowestWorkspaceId: ws });
    expect(read.pages.home).toMatchObject({ loads: 1, slowestMs: 610, overBudget: 0 });
    expect(read.budgetMs).toBe(2_000);
  });

  it('refuses a request through the edge, and a browser on this machine', async () => {
    const edge = await fetch(`${base}/api/load-reports/slowest`, { headers: { 'cf-ray': 'x-1' } });
    expect(edge.status).toBe(403);
    const browser = await fetch(`${base}/api/load-reports/slowest`, {
      headers: { origin: base, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    });
    expect(browser.status).toBe(403);
  });
});
