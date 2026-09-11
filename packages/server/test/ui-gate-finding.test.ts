/**
 * The UI gate, wired: a row an agent filed that reads as UI work and is being
 * BUILT with nobody's answer on it is named in the lead's stall frame and
 * counted on the verdict's `ungatedUi` line.
 *
 * Through a real server because the decision is assembled in three places —
 * the roster answers who filed the row, the store answers whether anybody
 * answered an item on it, and `ui-review-gate.ts` reads the words — and the
 * unit suite next door can only prove what the gate does with a list it was
 * handed.
 *
 * Every fixture is invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeepMovingVerdict } from '../src/keep-moving-verdict.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import { type Frame, listenFrames, settle } from './doc-activity-stall-harness.ts';
import { FILER, LEAD, PERSON } from './review-judge-harness.ts';
import { waitFor } from './wait-for.ts';

describe('a row built past the UI gate is the lead’s finding', () => {
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

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ui-gate-'));
    // No judge: every item this suite files is admitted, so a hold can never
    // stand in for the finding under test.
    handle = createServer({ port: 0, dataDir, keepMovingCadenceMs: 0 });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    for (const s of streams.splice(0)) await s.stop();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function agentStream(workspaceId: string, agent: { id: string }) {
    await jj(
      await post(`/workspaces/${workspaceId}/agents`, {
        agentId: agent.id,
        runtime: 'claude-code-local',
      }),
    );
    const res = await fetch(
      `${base}/workspaces/${workspaceId}/events:stream?agentId=${encodeURIComponent(agent.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    const stream = listenFrames(res);
    streams.push(stream);
    return stream;
  }

  /** A board, and one UI row the FILER agent filed and then took. */
  async function boardWithUiRow(title: string): Promise<{ workspaceId: string; taskId: string }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'atlas', leadAgentId: LEAD.id }),
    );
    // The filer's own attach — what puts it in the roster, which is the one
    // read that answers "an agent filed this" without guessing from a name.
    await jj(
      await post(`/workspaces/${workspace.id}/agents`, {
        agentId: FILER.id,
        runtime: 'claude-code-local',
      }),
    );
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspace.id}/tasks`, {
        title,
        body: 'Agent can reach the two actions without opening the row.',
        assignee: FILER.name,
        assigneeKind: 'agent',
        author: FILER,
      }),
    );
    for (const to of ['todo', 'in-progress']) {
      await jj(
        await post(`/workspaces/${workspace.id}/tasks/${task.id}/transition`, {
          to,
          author: FILER,
        }),
      );
    }
    return { workspaceId: workspace.id, taskId: task.id };
  }

  const stallFrames = (frames: Frame[]) => frames.filter((f) => f.event === STALL_EVENT);
  const ungatedOf = (frame: Frame | undefined) =>
    (frame?.data?.ungatedUi ?? []) as Array<Record<string, unknown>>;

  const latestVerdict = async (workspaceId: string) =>
    jj<{ latest: KeepMovingVerdict | null }>(
      await fetch(`${base}/workspaces/${workspaceId}/keep-moving`),
    );

  it('names the row and the word that made it UI work, and counts it', async () => {
    const { workspaceId, taskId } = await boardWithUiRow(
      'Agent can tap Plan and Review from the ticket button row',
    );
    const lead = await agentStream(workspaceId, LEAD);

    const told = await waitFor(
      () => {
        handle.nudgeStalls();
        return stallFrames(lead.frames).find((f) => ungatedOf(f).length > 0);
      },
      { timeout: 10_000, interval: 25, describe: 'a stall frame naming the ungated row' },
    );
    expect(ungatedOf(told)).toHaveLength(1);
    expect(ungatedOf(told)[0]).toMatchObject({ id: taskId, keyword: 'tap' });

    const { latest } = await latestVerdict(workspaceId);
    expect(latest?.verdict).toBe('FAIL');
    expect(latest?.ungatedUi).toEqual([taskId]);
  }, 20_000);

  it('says nothing about a row whose review item somebody answered', async () => {
    const { workspaceId, taskId } = await boardWithUiRow(
      'Agent can tap Plan and Review from the ticket button row',
    );
    const lead = await agentStream(workspaceId, LEAD);
    const { item } = await jj<{ item: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        review: {
          shape: 'decision',
          headline: 'Should Plan and Review move onto the ticket?',
          detail:
            'At stake: every reader of the board sees the change. Blocked until answered: the build.',
          options: [
            { id: 'o-1', label: 'Move them', detail: 'two fewer taps, a busier row' },
            { id: 'o-2', label: 'Leave them', detail: 'no change, the taps stay' },
          ],
        },
        author: FILER,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${item.id}/answer`, {
        text: 'Move them',
        author: PERSON,
      }),
    );

    handle.nudgeStalls();
    await settle(150);
    expect(stallFrames(lead.frames).filter((f) => ungatedOf(f).length > 0)).toEqual([]);
    const { latest } = await latestVerdict(workspaceId);
    expect(latest?.ungatedUi).toEqual([]);
  }, 20_000);

  it('says nothing about a UI row a person filed', async () => {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'atlas', leadAgentId: LEAD.id }),
    );
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspace.id}/tasks`, {
        title: 'Agent can tap Plan and Review from the ticket button row',
        body: 'Agent can reach the two actions without opening the row.',
        assignee: FILER.name,
        assigneeKind: 'agent',
        author: PERSON,
      }),
    );
    await jj(
      await post(`/workspaces/${workspace.id}/tasks/${task.id}/transition`, {
        to: 'in-progress',
        author: PERSON,
      }),
    );
    const lead = await agentStream(workspace.id, LEAD);

    handle.nudgeStalls();
    await settle(150);
    expect(stallFrames(lead.frames).filter((f) => ungatedOf(f).length > 0)).toEqual([]);
    const { latest } = await latestVerdict(workspace.id);
    expect(latest?.ungatedUi).toEqual([]);
  }, 20_000);

  it('says nothing about a row with no UI words in it', async () => {
    const { workspaceId } = await boardWithUiRow('Agent can retry a failed webhook delivery');
    const lead = await agentStream(workspaceId, LEAD);

    handle.nudgeStalls();
    await settle(150);
    expect(stallFrames(lead.frames).filter((f) => ungatedOf(f).length > 0)).toEqual([]);
    const { latest } = await latestVerdict(workspaceId);
    expect(latest?.ungatedUi).toEqual([]);
  }, 20_000);
});
