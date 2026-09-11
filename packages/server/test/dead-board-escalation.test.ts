/**
 * The escalation past the lead, end to end: a real server, a real board with
 * a real stuck row, and the server's own stall pass deciding that nobody is
 * on it.
 *
 * The unit suite next door pins the rules against a snapshot it builds by
 * hand. What it cannot see is whether the liveness reads are WIRED — whether
 * a board with no session attached reaches the escalation looking dead,
 * whether a Team Lead holding a stream on some other board is found there,
 * and whether the item the board files stops masking its own anchor from the
 * next tick. Each can be right in isolation while the feature delivers
 * nothing, which is what this file is for.
 *
 * All fixtures are synthetic — invented names. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeepMovingVerdict } from '../src/keep-moving-verdict.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_ESCALATION_ACTOR } from '../src/stall-escalation.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import { waitFor } from './wait-for.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
const TEAM_LEAD = 'agent-harbour-master';
const QUIET_MS = 200;

type Frame = { event: string; data?: Record<string, unknown> };

function listenFrames(res: Response): { frames: Frame[]; stop: () => Promise<void> } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  const pump = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          const frame: Frame = { event: 'message' };
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              try {
                frame.data = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
              } catch {}
            }
          }
          if (frame.event !== 'message') frames.push(frame);
        }
      }
    } catch {}
  })();
  return {
    frames,
    stop: async () => {
      stopped = true;
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

describe('a board nobody is on files past its lead', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  const streams: Array<ReturnType<typeof listenFrames>> = [];

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'dead-board-'));
    handle = createServer({
      port: 0,
      dataDir,
      // A short but REAL quiet window, so a write the board makes on a row
      // is a movement the next pass can see — that is what the anchor test
      // below is about. Zero would hide it: every pass a millisecond later
      // reads the row as quiet again.
      stallNudgeQuietMs: QUIET_MS,
      // Dead the moment nobody is deliverable — the window is a number in
      // the unit suite; here the wiring is the subject.
      stallEscalateMs: 0,
      // An attachment is live only while it holds a stream.
      observedWorkFreshMs: 0,
      keepMovingCadenceMs: 0,
      spawnerAgentId: TEAM_LEAD,
    });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    for (const s of streams.splice(0)) await s.stop();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A board with a lead seat, its lead attached but holding NO stream. */
  async function deadBoard(): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id }),
    );
    await jj(
      await post(`/workspaces/${workspace.id}/agents`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    return workspace.id;
  }

  async function stuckRow(workspaceId: string, title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    for (const [to, author] of [
      ['todo', PERSON],
      ['in-progress', LEAD],
    ] as const) {
      await jj(
        await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, {
          to,
          author,
          workspaceId,
        }),
      );
    }
    return task.id;
  }

  /** The ticket's items off the store itself, withdrawn ones included —
   *  the reader's route drops those, and a withdrawal is half of what this
   *  file asserts. */
  const reviewItems = (taskId: string) => handle.tasks.listReviewItems(taskId);

  const latestVerdict = async (workspaceId: string) =>
    jj<{ latest: KeepMovingVerdict | null }>(
      await fetch(`${base}/workspaces/${workspaceId}/keep-moving`),
    );

  it('with nobody reachable, files ONE item to the reader as the server', async () => {
    const ws = await deadBoard();
    const taskId = await stuckRow(ws, 'Rank results by recency');
    // Polled, because the row's quiet clock is real: a pass in the same
    // millisecond as the transition reads it as having just moved.
    const items = await waitFor(() => {
      handle.nudgeStalls();
      const got = reviewItems(taskId);
      return got.length > 0 ? got : undefined;
    });
    handle.nudgeStalls();
    expect(items).toHaveLength(1);
    expect(items[0]?.createdBy).toBe(STALL_ESCALATION_ACTOR.name);
    expect(items[0]?.review.withdrawnAt).toBeUndefined();
  });

  it('the item does not hide its own anchor: the next pass still counts the row stalled', async () => {
    const ws = await deadBoard();
    const taskId = await stuckRow(ws, 'Rank results by recency');
    await waitFor(() => {
      handle.nudgeStalls();
      return reviewItems(taskId).length > 0;
    });
    // The very next pass, INSIDE the quiet window of the filing: the item's
    // own write must not read as the row moving, or the row would drop off
    // the list, the item would be withdrawn as "no longer stuck", and the
    // board would file it again a window later — forever.
    handle.nudgeStalls();
    const { latest } = await latestVerdict(ws);
    expect(latest?.stalled).toContain(taskId);
    expect(latest?.waiting ?? []).toHaveLength(0);
    expect(latest?.escalated).toBe(1);
    // And still the one item, standing: the pass revised nothing, withdrew
    // nothing and filed nothing.
    const items = reviewItems(taskId);
    expect(items).toHaveLength(1);
    expect(items[0]?.review.withdrawnAt).toBeUndefined();
  });

  it('with Team Lead on ANOTHER board, sends it the frame there and files nothing', async () => {
    const ws = await deadBoard();
    const taskId = await stuckRow(ws, 'Rank results by recency');
    const { workspace: other } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'harbour' }),
    );
    await jj(
      await post(`/workspaces/${other.id}/agents`, {
        agentId: TEAM_LEAD,
        runtime: 'claude-code-local',
      }),
    );
    const res = await fetch(
      `${base}/workspaces/${other.id}/events:stream?agentId=${encodeURIComponent(TEAM_LEAD)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    const teamLead = listenFrames(res);
    streams.push(teamLead);

    const frames = await waitFor(() => {
      handle.nudgeStalls();
      const got = teamLead.frames.filter((f) => f.event === STALL_EVENT);
      return got.length > 0 ? got : undefined;
    });
    expect(frames[0]?.data).toMatchObject({
      workspaceId: ws,
      taskId,
      escalatedFrom: LEAD.id,
    });
    handle.nudgeStalls();
    expect(reviewItems(taskId)).toHaveLength(0);
  });

  it('withdraws the item the pass a session is on the board again', async () => {
    const ws = await deadBoard();
    const taskId = await stuckRow(ws, 'Rank results by recency');
    await waitFor(() => {
      handle.nudgeStalls();
      return reviewItems(taskId).length > 0;
    });
    // The lead opens a stream: the board is alive, the row is exactly as
    // stuck, and the item comes back.
    const res = await fetch(
      `${base}/workspaces/${ws}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    streams.push(listenFrames(res));
    await waitFor(() => {
      handle.nudgeStalls();
      return reviewItems(taskId)[0]?.review.withdrawnAt !== undefined;
    });
    expect(reviewItems(taskId)).toHaveLength(1);
  });
});
