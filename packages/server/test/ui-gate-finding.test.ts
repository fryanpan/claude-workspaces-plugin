/**
 * The UI gate, wired: a row an agent filed whose BUILDER has changed a file a
 * person looks at, with nobody's answer on it, is named in the lead's stall
 * frame and counted on the verdict's `ungatedUi` line.
 *
 * Through a real server because the decision is assembled in four places —
 * the roster answers who filed the row, the dispatch registry answers where
 * its builder works, git answers what that builder changed, and the store
 * answers whether anybody answered an item on it. The unit suite next door
 * can only prove what the gate does with a list it was handed.
 *
 * The controls are the point of this file as much as the positive is. Two of
 * them rebuild the defect that rewrote the gate: a row whose prose reads as
 * UI work while its builder is editing the server, and a row with no worktree
 * to read at all. Both were findings before; both are silence now.
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
import { type BuilderWorktree, makeBuilderWorktree } from './builder-worktree-fixture.ts';
import { type Frame, listenFrames, settle } from './doc-activity-stall-harness.ts';
import { FILER, LEAD, PERSON } from './review-judge-harness.ts';
import { waitFor } from './wait-for.ts';

/** What a builder restyling the board has written. */
const UI_WORK = { 'packages/workspaces-app/src/board.css': '.task-card { padding: 8px; }\n' };
/** What a builder fixing the server's idle clock has written. */
const SERVER_WORK = {
  'packages/server/src/ready-nudge.ts': 'export const READY = 1;\n',
  'packages/server/test/ready-nudge.test.ts': 'export const T = 1;\n',
};

describe('a row built past the UI gate is the lead’s finding', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  const streams: Array<ReturnType<typeof listenFrames>> = [];
  const worktrees: BuilderWorktree[] = [];

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
    for (const wt of worktrees.splice(0)) wt.cleanup();
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

  /**
   * Give this row a builder, working in a checkout that holds `work`.
   *
   * `inherited` is whatever a PREVIOUS occupant of that checkout had already
   * committed before this dispatch was registered — the reuse case.
   */
  async function dispatch(
    workspaceId: string,
    taskId: string,
    work: Record<string, string>,
    inherited?: Record<string, string>,
  ): Promise<void> {
    const wt = makeBuilderWorktree(inherited ?? {});
    worktrees.push(wt);
    if (inherited) wt.commit('the previous occupant');
    await jj(
      await post(`/workspaces/${workspaceId}/dispatches`, { taskId, worktreePath: wt.path }),
    );
    wt.edit(work);
  }

  /** A board, and one row the FILER agent filed and then took. */
  async function boardWithRow(
    title: string,
    body = 'Agent can reach the two actions without opening the row.',
    author: typeof FILER | typeof PERSON = FILER,
  ): Promise<{ workspaceId: string; taskId: string }> {
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
    const { task } = await jj<{ task: { id: string; status: string } }>(
      await post(`/workspaces/${workspace.id}/tasks`, {
        title,
        body,
        assignee: FILER.name,
        assigneeKind: 'agent',
        author,
      }),
    );
    // Only an agent's row starts in triage; a person's lands in todo, and
    // transitioning it there again is refused as a no-op.
    const steps = task.status === 'todo' ? ['in-progress'] : ['todo', 'in-progress'];
    for (const to of steps) {
      await jj(
        await post(`/workspaces/${workspace.id}/tasks/${task.id}/transition`, { to, author }),
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

  const waitForFinding = (lead: { frames: Frame[] }) =>
    waitFor(
      () => {
        handle.nudgeStalls();
        return stallFrames(lead.frames).find((f) => ungatedOf(f).length > 0);
      },
      { timeout: 10_000, interval: 25, describe: 'a stall frame naming the ungated row' },
    );

  const expectSilence = async (lead: { frames: Frame[] }, workspaceId: string) => {
    handle.nudgeStalls();
    await settle(150);
    expect(stallFrames(lead.frames).filter((f) => ungatedOf(f).length > 0)).toEqual([]);
    const { latest } = await latestVerdict(workspaceId);
    expect(latest?.ungatedUi).toEqual([]);
  };

  it('names the row, the changed file, and the word its prose agrees with', async () => {
    const { workspaceId, taskId } = await boardWithRow(
      'Agent can tap Plan and Review from the ticket button row',
    );
    await dispatch(workspaceId, taskId, UI_WORK);
    const lead = await agentStream(workspaceId, LEAD);

    const told = await waitForFinding(lead);
    expect(ungatedOf(told)).toHaveLength(1);
    expect(ungatedOf(told)[0]).toMatchObject({
      id: taskId,
      file: 'packages/workspaces-app/src/board.css',
      keyword: 'tap',
    });

    const { latest } = await latestVerdict(workspaceId);
    expect(latest?.verdict).toBe('FAIL');
    expect(latest?.ungatedUi).toEqual([taskId]);
  }, 20_000);

  it('catches a row that changes a screen without its words saying so', async () => {
    // The miss the word list could not see: no UI word anywhere, and the
    // builder is editing the board's stylesheet.
    const { workspaceId, taskId } = await boardWithRow(
      'Agent can see why a task is blocked',
      'Show the reason on the card so nobody has to open the row.',
    );
    await dispatch(workspaceId, taskId, UI_WORK);
    const lead = await agentStream(workspaceId, LEAD);

    const told = await waitForFinding(lead);
    expect(ungatedOf(told)[0]).toMatchObject({
      id: taskId,
      file: 'packages/workspaces-app/src/board.css',
    });
    expect(ungatedOf(told)[0]?.keyword).toBeUndefined();
    const { latest } = await latestVerdict(workspaceId);
    expect(latest?.ungatedUi).toEqual([taskId]);
  }, 20_000);

  it('says nothing about a row whose words read as UI while its builder edits the server', async () => {
    // The recorded false positive, end to end: "button" is in the body only
    // because the body says which board control filed the row.
    const { workspaceId, taskId } = await boardWithRow(
      'Agent can be told when a task becomes ready',
      'Steps 1–3 are held as backlog, because the board’s New task button sends no goal ' +
        'and the store defaults to chores. The fix is the idle clock.',
    );
    await dispatch(workspaceId, taskId, SERVER_WORK);
    const lead = await agentStream(workspaceId, LEAD);
    await expectSilence(lead, workspaceId);
  }, 20_000);

  it('says nothing about a builder inheriting a finished task’s UI work', async () => {
    // A worktree outlives a dispatch. Everything the previous occupant
    // committed is still on the branch, and attributing it to this row would
    // be the same false positive in a new spelling.
    const { workspaceId, taskId } = await boardWithRow(
      'Agent can be told when a task becomes ready',
      'The fix is the idle clock.',
    );
    await dispatch(workspaceId, taskId, SERVER_WORK, UI_WORK);
    const lead = await agentStream(workspaceId, LEAD);
    await expectSilence(lead, workspaceId);
  }, 20_000);

  it('says nothing about a UI row nobody registered a builder for', async () => {
    const { workspaceId } = await boardWithRow(
      'Agent can tap Plan and Review from the ticket button row',
    );
    const lead = await agentStream(workspaceId, LEAD);
    await expectSilence(lead, workspaceId);
  }, 20_000);

  it('says nothing about a row whose review item somebody answered', async () => {
    const { workspaceId, taskId } = await boardWithRow(
      'Agent can tap Plan and Review from the ticket button row',
    );
    await dispatch(workspaceId, taskId, UI_WORK);
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

    await expectSilence(lead, workspaceId);
  }, 20_000);

  it('says nothing about a UI row a person filed', async () => {
    const { workspaceId, taskId } = await boardWithRow(
      'Agent can tap Plan and Review from the ticket button row',
      'Agent can reach the two actions without opening the row.',
      PERSON,
    );
    await dispatch(workspaceId, taskId, UI_WORK);
    const lead = await agentStream(workspaceId, LEAD);
    await expectSilence(lead, workspaceId);
  }, 20_000);
});
