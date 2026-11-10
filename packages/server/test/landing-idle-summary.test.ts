import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@claude-workspaces/core';
import { agoText } from '../src/landing-review.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

/**
 * A project line on Home whose only summary is about the machinery — a server
 * starting, routine ticks — shows the board's last real activity instead.
 *
 * `board-summary.test.ts` proves such a sentence is refused when written and
 * when read. This file proves what the reader then sees: the row on `/`,
 * through the real route, carries the time of the board's last REAL activity —
 * not the sentence, not a blank line, and not the time the idle sentence was
 * written. So Harborlight's real activity is three hours old while its idle
 * sentence was written a moment ago: a row reading "just now" would be telling
 * the reader about the tick. A second board holding a sentence about work is
 * the control that the stored file was read at all.
 *
 * The summary store and the task files are read when the server is created,
 * so the boards are made on one server, their files edited at rest, and the
 * page read from a second server on the same data directory.
 */

const AGENT: User = { id: 'agent-one', name: 'One', kind: 'known', color: '#111' };
const IDLE = 'Starting up the server and running routine ticks with no other activity.';
const WORK = 'Moving the Riverbend export onto the new schema.';
const HOURS_AGO = 3 * 3_600_000;

let dataDir: string;
let handle: ServerHandle;
let base: string;
let idleBoard: string;
let workBoard: string;
let realActivityAt: number;

async function addTask(b: string, wsId: string, title: string): Promise<void> {
  const res = await fetch(`${b}/workspaces/${encodeURIComponent(wsId)}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: AGENT, title, assignee: 'One', assigneeKind: 'agent' }),
  });
  expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
}

/** Move every timestamp written since `since` back by `by`: the board's
 *  creation, its task's creation and last update — all its real activity. */
function backdateBoard(wsId: string, since: number, by: number): void {
  const path = join(dataDir, 'workspaces', `${wsId}.tasks.json`);
  const shift = (v: unknown): unknown => {
    if (typeof v === 'number' && v >= since && v <= Date.now()) return v - by;
    if (Array.isArray(v)) return v.map(shift);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x)]));
    }
    return v;
  };
  writeFileSync(path, JSON.stringify(shift(JSON.parse(readFileSync(path, 'utf8')))));
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'landing-idle-summary-'));
  const started = Date.now();
  const first = createServer({ port: 0, dataDir });
  const firstBase = `http://127.0.0.1:${first.port}`;
  idleBoard = await seedBoard(firstBase, { name: 'Harborlight' });
  workBoard = await seedBoard(firstBase, { name: 'Riverbend' });
  // Real activity on both boards, so each is a Prioritized Project with a
  // last-active time to fall back to.
  await addTask(firstBase, idleBoard, 'Draft the Harborlight launch notes');
  await addTask(firstBase, workBoard, 'Move the Riverbend export');
  await first.stop();

  backdateBoard(idleBoard, started, HOURS_AGO);
  realActivityAt = Date.now() - HOURS_AGO;
  const at = Date.now();
  writeFileSync(
    join(dataDir, 'board-summaries.json'),
    `${JSON.stringify({ [idleBoard]: { text: IDLE, at }, [workBoard]: { text: WORK, at } })}\n`,
  );
  handle = createServer({ port: 0, dataDir });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

/** The summary line of the Prioritized Projects row linking to a board. */
function summaryLineOf(html: string, wsId: string): string | undefined {
  const rows = html.split('<li class="grp grp-flex">').slice(1);
  const row = rows.find((r) => r.includes(`/workspaces/${encodeURIComponent(wsId)}`));
  return row?.match(/<div class="grp-summary">([\s\S]*?)<\/div>/)?.[1];
}

describe('a Home project line whose only summary is a start-up or idle-tick one', () => {
  it('shows the time of the last real activity, not the sentence, its time, or nothing', async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('Prioritized Projects');
    expect(html).not.toContain(IDLE);

    const idle = summaryLineOf(html, idleBoard);
    expect(idle, 'Harborlight has a project row').toBeDefined();
    // The real activity three hours ago, not the tick written just now.
    const expected = agoText(realActivityAt, Date.now());
    expect(expected).toBe('3 hr ago');
    expect(idle?.trim()).toBe(`<span class="ago">${expected}</span>`);

    // CONTROL: the same file's sentence about work is shown, so the store was
    // read and the idle one was refused, not missed.
    expect(summaryLineOf(html, workBoard)).toBe(`${WORK} <span class="ago">just now</span>`);
  });
});
