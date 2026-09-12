/**
 * "Done when" end to end: the list is a FIELD on the task, the builder
 * reports against it, and the last line met closes the task by itself.
 *
 * Driven over HTTP because the route layer hand-copies body fields and
 * nothing type-checks it — a field the route drops still answers 200. Every
 * property here is written over the wire and read back over the wire.
 *
 * The six behaviours are the ones the feature is defined by:
 *   1. lines persist and round-trip, and a re-send by id keeps the verdict;
 *   2. `met` with no proof is refused, naming the line;
 *   3. the last line met moves the task to done and says which line closed it;
 *   4. the owner's `Looks right` on their line closes it the same way;
 *   5. a manual move to done with an open line is refused, naming that line;
 *   6. a task with no lines moves to done exactly as it always did.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';
import { seedBoard } from './workspace-seed.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-harbourlight', name: 'Harborlight', kind: 'known', color: '#888888' };

interface DoneWhenLine {
  id: string;
  text: string;
  verdict?: string;
  proof?: Array<{ text: string; url?: string }>;
}
interface DoneWhenBody {
  lines: DoneWhenLine[];
  closed: boolean;
  status: string;
  error?: string;
  message?: string;
}

describe('done-when lines on a task', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
      body: JSON.stringify(body),
    });
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

  /** A task, optionally filed with its criteria already on it. */
  const mkTask = async (title: string, doneWhen?: unknown[]): Promise<Task> => {
    const r = await post(`/workspaces/${ws}/tasks`, {
      author: AGENT,
      title,
      ...(doneWhen !== undefined ? { doneWhen } : {}),
    });
    return ((await r.json()) as { task: Task }).task;
  };

  const detail = async (taskId: string): Promise<Task> => {
    const r = await get(`/workspaces/${ws}/tasks/${taskId}/detail`);
    return ((await r.json()) as { task: Task }).task;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'donewhen-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('files the lines with the task, reads them back, and keeps a verdict across an edit', async () => {
    const task = await mkTask('Agent can read the list back', [
      { text: 'the list survives a read' },
      { text: 'a second line keeps its place' },
    ]);

    const filed = await detail(task.id);
    expect(filed.doneWhen?.map((l) => l.text)).toEqual([
      'the list survives a read',
      'a second line keeps its place',
    ]);
    // Every line has an id of its own, which is what the report addresses.
    expect(new Set(filed.doneWhen?.map((l) => l.id)).size).toBe(2);
    // Nothing is reported yet, so no line carries a verdict — the panel draws
    // no chip at all before the builder speaks.
    expect(filed.doneWhen?.every((l) => l.verdict === undefined)).toBe(true);

    const first = filed.doneWhen?.[0] as DoneWhenLine;
    const reported = await post(`/workspaces/${ws}/tasks/${task.id}/done-when/report`, {
      author: AGENT,
      lines: [
        {
          id: first.id,
          verdict: 'met',
          proof: [{ text: 'ran the suite', url: 'https://example.test/run' }],
        },
      ],
    });
    expect(reported.status).toBe(200);

    // Rewriting the WORDS of a proved line is not a retraction: the line is
    // re-sent by id with new text and keeps its verdict and its proof.
    const rewritten = await post(`/workspaces/${ws}/tasks/${task.id}/done-when`, {
      author: AGENT,
      lines: [
        { id: first.id, text: 'the list survives a read, and says so' },
        { text: 'a third line arrives with no id' },
      ],
    });
    expect(rewritten.status).toBe(200);

    const after = await detail(task.id);
    expect(after.doneWhen?.map((l) => l.text)).toEqual([
      'the list survives a read, and says so',
      'a third line arrives with no id',
    ]);
    expect(after.doneWhen?.[0]?.verdict).toBe('met');
    expect(after.doneWhen?.[0]?.proof?.[0]?.url).toBe('https://example.test/run');
    // The line dropped from the sequence is gone — the write is the whole list.
    expect(after.doneWhen?.some((l) => l.text === 'a second line keeps its place')).toBe(false);
  });

  it('refuses a line reported met with no proof, and names the line', async () => {
    const task = await mkTask('Agent can be held to proof', [
      { text: 'the share link opens the list for a signed-out reader' },
    ]);
    const lineId = (await detail(task.id)).doneWhen?.[0]?.id as string;

    const refused = await post(`/workspaces/${ws}/tasks/${task.id}/done-when/report`, {
      author: AGENT,
      lines: [{ id: lineId, verdict: 'met' }],
    });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as DoneWhenBody;
    expect(body.error).toBe('proof-required');
    expect(body.message).toContain('the share link opens the list for a signed-out reader');

    // Nothing was written: the refused report left the line exactly as it was.
    expect((await detail(task.id)).doneWhen?.[0]?.verdict).toBeUndefined();

    // The positive control — the same report with proof lands.
    const ok = await post(`/workspaces/${ws}/tasks/${task.id}/done-when/report`, {
      author: AGENT,
      lines: [{ id: lineId, verdict: 'met', proof: [{ text: 'opened it in a private window' }] }],
    });
    expect(ok.status).toBe(200);
  });

  it('moves the task to done itself when the last open line is reported met', async () => {
    const task = await mkTask('Agent can watch the task close itself', [
      { text: 'the first outcome holds' },
      { text: 'the last outcome holds' },
    ]);
    const lines = (await detail(task.id)).doneWhen as DoneWhenLine[];

    const partial = await post(`/workspaces/${ws}/tasks/${task.id}/done-when/report`, {
      author: AGENT,
      lines: [{ id: lines[0]?.id, verdict: 'met', proof: [{ text: 'checked it' }] }],
    });
    // One of two met is not a close — the task is still open.
    expect(((await partial.json()) as DoneWhenBody).closed).toBe(false);
    expect((await detail(task.id)).status).not.toBe('done');

    const last = await post(`/workspaces/${ws}/tasks/${task.id}/done-when/report`, {
      author: AGENT,
      lines: [{ id: lines[1]?.id, verdict: 'met', proof: [{ text: 'checked that too' }] }],
    });
    const closing = (await last.json()) as DoneWhenBody;
    expect(closing.closed).toBe(true);
    expect(closing.status).toBe('done');

    const closed = await detail(task.id);
    expect(closed.status).toBe('done');
    // One note on the Activity tab, naming the line that closed it.
    const notes = (closed.notes ?? []).map((n) => n.text);
    expect(notes.some((t) => t.includes('the last outcome holds'))).toBe(true);
  });

  it("closes the task on the owner's Looks right, and refuses that button to an agent", async () => {
    const task = await mkTask('Bryan can close the task with one look', [
      { text: 'the panel reads well on the iPad' },
    ]);
    const lineId = (await detail(task.id)).doneWhen?.[0]?.id as string;

    await post(`/workspaces/${ws}/tasks/${task.id}/done-when/report`, {
      author: AGENT,
      lines: [{ id: lineId, verdict: 'owner' }],
    });
    expect((await detail(task.id)).doneWhen?.[0]?.verdict).toBe('owner');

    // An agent cannot answer its own owner line.
    const byAgent = await post(`/workspaces/${ws}/tasks/${task.id}/done-when/${lineId}/check`, {
      author: AGENT,
      verdict: 'met',
    });
    expect(byAgent.status).toBe(403);
    expect((await detail(task.id)).status).not.toBe('done');

    const byPerson = await post(`/workspaces/${ws}/tasks/${task.id}/done-when/${lineId}/check`, {
      author: PERSON,
      verdict: 'met',
    });
    expect(byPerson.status).toBe(200);
    expect(((await byPerson.json()) as DoneWhenBody).closed).toBe(true);
    expect((await detail(task.id)).status).toBe('done');
  });

  it('refuses a manual move to done while a line is open, and names the first open line', async () => {
    const task = await mkTask('Agent cannot close over an open line', [
      { text: 'the first outcome is proved' },
      { text: 'the second outcome is still open' },
    ]);
    const lines = (await detail(task.id)).doneWhen as DoneWhenLine[];
    await post(`/workspaces/${ws}/tasks/${task.id}/done-when/report`, {
      author: AGENT,
      lines: [{ id: lines[0]?.id, verdict: 'met', proof: [{ text: 'proved it' }] }],
    });

    const refused = await post(`/workspaces/${ws}/tasks/${task.id}/transition`, {
      to: 'done',
      author: AGENT,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const body = (await refused.json()) as { error?: string; message?: string };
    expect(body.error).toBe('done-when-open');
    expect(body.message).toContain('the second outcome is still open');
    // The line already met is not the one named.
    expect(body.message).not.toContain('the first outcome is proved');
    expect((await detail(task.id)).status).not.toBe('done');
  });

  it('leaves a task with no done-when lines closing exactly as it always did', async () => {
    const task = await mkTask('Agent can still close an ordinary task');
    expect((await detail(task.id)).doneWhen).toBeUndefined();

    const moved = await post(`/workspaces/${ws}/tasks/${task.id}/transition`, {
      to: 'done',
      author: AGENT,
    });
    expect(moved.status).toBe(200);
    expect((await detail(task.id)).status).toBe('done');
  });

  it('clears the list with an empty array, and refuses a write that names no lines at all', async () => {
    const task = await mkTask('Agent can drop a list that no longer says what done means', [
      { text: 'an outcome nobody wants any more' },
    ]);

    const missing = await post(`/workspaces/${ws}/tasks/${task.id}/done-when`, { author: AGENT });
    expect(missing.status).toBe(400);
    expect((await detail(task.id)).doneWhen).toHaveLength(1);

    const cleared = await post(`/workspaces/${ws}/tasks/${task.id}/done-when`, {
      author: AGENT,
      lines: [],
    });
    expect(cleared.status).toBe(200);
    expect((await detail(task.id)).doneWhen).toBeUndefined();

    // And with the list gone, the ordinary close works again.
    const moved = await post(`/workspaces/${ws}/tasks/${task.id}/transition`, {
      to: 'done',
      author: AGENT,
    });
    expect(moved.status).toBe(200);
  });
});
