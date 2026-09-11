/**
 * `dispatch.requested` through the running server.
 *
 * What this file pins is the measurement the event exists for: the audit log
 * must end up holding three timestamps for one ticket — the row going
 * in-progress, the lead asking for a lane, and the lane's first note — so the
 * one opaque wait between the first and the last can be split in two. It also
 * pins the two costs the event is required NOT to have: it never rides the
 * workspace stream, and a dispatch survives an audit log that cannot be
 * written at all.
 *
 * All fixtures are synthetic — invented names (Riverbend, Harborlight). The
 * repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { eventsLogPath } from '../src/task-event-bus.ts';
import { waitFor } from './wait-for.ts';

const PERSON = { id: 'known-riverbend', name: 'Riverbend', kind: 'person' };
const LEAD = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };

interface LoggedEvent {
  event: string;
  taskId?: string;
  outcome?: string;
  reason?: string;
  agentName?: string;
  actor?: { id?: string; name?: string; kind?: string };
  to?: string;
  ts: number;
}

describe('dispatch.requested', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let workspaceId: string;
  /** Worktree directories made for the dispatches, removed at the end. */
  let worktrees: string[];

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const put = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  /** The board's audit log, as rows. Missing file reads as empty — the log is
   *  created by the first append, which is exactly what is being waited on. */
  const logRows = (): LoggedEvent[] => {
    let raw: string;
    try {
      raw = readFileSync(eventsLogPath(dataDir, workspaceId), 'utf8');
    } catch {
      return [];
    }
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LoggedEvent);
  };

  const dispatchRows = (taskId: string): LoggedEvent[] =>
    logRows().filter((r) => r.event === 'dispatch.requested' && r.taskId === taskId);

  const worktree = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-requested-wt-'));
    worktrees.push(dir);
    return dir;
  };

  async function inProgressRow(title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, {
        to: 'todo',
        author: PERSON,
        workspaceId,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, {
        to: 'in-progress',
        author: LEAD,
        workspaceId,
      }),
    );
    return task.id;
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'dispatch-requested-'));
    worktrees = [];
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'timing board', author: LEAD, leadAgentId: LEAD.id }),
    );
    workspaceId = workspace.id;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    for (const dir of worktrees) rmSync(dir, { recursive: true, force: true });
  });

  it('writes the lead’s ask, with the task and the reason, when a lane is taken', async () => {
    const taskId = await inProgressRow('Wire the results page');
    await jj(
      await post(`/workspaces/${workspaceId}/dispatches`, {
        taskId,
        worktreePath: worktree(),
        reason: 'next in the goal band',
        agentName: 'harborlight-builder',
        author: LEAD,
      }),
    );
    const row = await waitFor(() => dispatchRows(taskId)[0], {
      describe: 'dispatch.requested in the audit log',
    });
    expect(row.outcome).toBe('registered');
    expect(row.reason).toBe('next in the goal band');
    expect(row.agentName).toBe('harborlight-builder');
    expect(row.actor?.id).toBe(LEAD.id);
  });

  it('splits the wait: transitioned → requested → the lane’s first note', async () => {
    // The whole point of the event. Before it, these three moments were two,
    // and the interval between them could not be attributed.
    const taskId = await inProgressRow('Ship the importer');
    await jj(
      await post(`/workspaces/${workspaceId}/dispatches`, {
        taskId,
        worktreePath: worktree(),
        reason: 'unblocked',
        author: LEAD,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/notes`, {
        kind: 'turn',
        text: 'Worktree is up; reading the route.',
        agent: 'harborlight-builder',
      }),
    );
    const legs = await waitFor(
      () => {
        const rows = logRows().filter((r) => r.taskId === taskId);
        const flip = rows.find((r) => r.event === 'task.transitioned' && r.to === 'in-progress');
        const asked = rows.find((r) => r.event === 'dispatch.requested');
        const lane = rows.find((r) => r.event === 'task.noted');
        return flip && asked && lane ? { flip, asked, lane } : undefined;
      },
      { describe: 'all three timing rows in the audit log' },
    );
    // Order, not duration: the clock a loaded machine reports is not the
    // behaviour under test, but which marker comes first is.
    expect(legs.flip.ts).toBeLessThanOrEqual(legs.asked.ts);
    expect(legs.asked.ts).toBeLessThanOrEqual(legs.lane.ts);
  });

  it('records the ask that the cap refused, at the moment it was made', async () => {
    // The row nothing else on the board holds: a lane wanted while every slot
    // was held. Without it, the wait for a slot is indistinguishable from the
    // lead not having got to the row yet.
    await jj(await put(`/workspaces/${workspaceId}/parallelism-cap`, { cap: 1, author: LEAD }));
    const held = await inProgressRow('Hold the only slot');
    const queued = await inProgressRow('Wait for the slot');
    await jj(
      await post(`/workspaces/${workspaceId}/dispatches`, {
        taskId: held,
        worktreePath: worktree(),
      }),
    );
    const refused = await post(`/workspaces/${workspaceId}/dispatches`, {
      taskId: queued,
      worktreePath: worktree(),
      reason: 'top of the band',
      author: LEAD,
    });
    expect(refused.status).toBe(409);
    const row = await waitFor(() => dispatchRows(queued)[0], {
      describe: 'cap-reached dispatch.requested in the audit log',
    });
    expect(row.outcome).toBe('cap-reached');
    expect(row.reason).toBe('top of the band');
  });

  it('never rides the workspace stream', async () => {
    const taskId = await inProgressRow('Stay off the stream');
    const res = await fetch(
      `${base}/workspaces/${workspaceId}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          text += decoder.decode(value, { stream: true });
        }
      } catch {}
    })();
    try {
      await jj(
        await post(`/workspaces/${workspaceId}/dispatches`, {
          taskId,
          worktreePath: worktree(),
          author: LEAD,
        }),
      );
      // The audit log is the proof the event actually happened; the stream is
      // then asserted not to carry it. Without this wait the assertion below
      // would pass against an event that was simply never written.
      await waitFor(() => dispatchRows(taskId)[0], { describe: 'the event was written at all' });
      // …and the positive control that the stream is alive and would have
      // carried it: a transition on the same row, after the dispatch.
      await jj(
        await post(`/workspaces/${workspaceId}/tasks/${taskId}/transition`, {
          to: 'done',
          author: LEAD,
          workspaceId,
        }),
      );
      await waitFor(() => text.includes('task.transitioned') || undefined, {
        describe: 'the stream carries an event it is supposed to',
      });
      expect(text).not.toContain('dispatch.requested');
    } finally {
      await reader.cancel().catch(() => {});
      await pump;
    }
  });

  it('registers the dispatch even when the audit log cannot be written', async () => {
    // AC4's teeth, end to end: the log path is replaced by a DIRECTORY, so
    // every append to it throws EISDIR for as long as the test runs.
    const taskId = await inProgressRow('Survive a broken log');
    const logPath = eventsLogPath(dataDir, workspaceId);
    try {
      unlinkSync(logPath);
    } catch {}
    mkdirSync(logPath, { recursive: true });
    const res = await post(`/workspaces/${workspaceId}/dispatches`, {
      taskId,
      worktreePath: worktree(),
      reason: 'the log is broken and this must still run',
      author: LEAD,
    });
    expect(res.status).toBe(200);
    const listed = await jj<{ dispatches: Array<{ taskId: string }> }>(
      await fetch(`${base}/workspaces/${workspaceId}/dispatches`),
    );
    expect(listed.dispatches.some((d) => d.taskId === taskId)).toBe(true);
  });
});
