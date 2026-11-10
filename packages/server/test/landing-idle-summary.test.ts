import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@claude-workspaces/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

/**
 * A project line on Home whose only summary is about the machinery — a server
 * starting, routine ticks — shows the board's last real activity instead.
 *
 * `board-summary.test.ts` proves such a sentence is refused when written and
 * when read. This file proves what the reader then sees: the row on `/`,
 * through the real route, carries the last-active time and not the sentence,
 * and is not blank. A second board holding a sentence about work is the
 * control that the stored file was read at all.
 *
 * The summary store is read once when the server is created, so the boards are
 * made on one server, the sentences written beside its data, and the page read
 * from a second server on the same data directory.
 */

const AGENT: User = { id: 'agent-one', name: 'One', kind: 'known', color: '#111' };
const IDLE = 'Starting up the server and running routine ticks with no other activity.';
const WORK = 'Moving the Riverbend export onto the new schema.';

let dataDir: string;
let handle: ServerHandle;
let base: string;
let idleBoard: string;
let workBoard: string;

async function addTask(b: string, wsId: string, title: string): Promise<void> {
  const res = await fetch(`${b}/workspaces/${encodeURIComponent(wsId)}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: AGENT, title, assignee: 'One', assigneeKind: 'agent' }),
  });
  expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'landing-idle-summary-'));
  const first = createServer({ port: 0, dataDir });
  const firstBase = `http://127.0.0.1:${first.port}`;
  idleBoard = await seedBoard(firstBase, { name: 'Harborlight' });
  workBoard = await seedBoard(firstBase, { name: 'Riverbend' });
  // Real activity on both boards, so each is a Prioritized Project with a
  // last-active time to fall back to.
  await addTask(firstBase, idleBoard, 'Draft the Harborlight launch notes');
  await addTask(firstBase, workBoard, 'Move the Riverbend export');
  await first.stop();

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
  it('shows the last real activity, not the sentence and not nothing', async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('Prioritized Projects');

    const idle = summaryLineOf(html, idleBoard);
    expect(idle, 'Harborlight has a project row').toBeDefined();
    expect(idle).not.toContain('Starting up the server');
    expect(idle).not.toContain('routine ticks');
    // The fallback: the board's last real activity (the task made a moment
    // ago), not the empty-board text and not a blank line.
    expect(idle?.trim()).toBe('<span class="ago">just now</span>');
    expect(html).not.toContain(IDLE);

    // CONTROL: the same file's sentence about work is shown, so the store was
    // read and the idle one was refused, not missed.
    expect(summaryLineOf(html, workBoard)).toBe(`${WORK} <span class="ago">just now</span>`);
  });
});
