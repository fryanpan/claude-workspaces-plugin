/**
 * The whole path, on a real server: an agent posts a turn note saying it is
 * waiting on a person, files nothing, and the lead is woken about that task
 * under the `waiting-unfiled` bucket.
 *
 * Driven through the routes an agent actually calls — the board, the task,
 * the transition, `POST …/tasks/<id>/notes` — and read off the lead's own
 * event stream, so what is asserted is what a lead would see rather than the
 * return value of an internal function.
 *
 * The control is the same note with a review item filed on the same task:
 * that task never reaches a finding list, while a second task with the note
 * and nothing filed does — one run, both tasks, so the control cannot pass by
 * the wake simply failing to fire.
 *
 * All fixtures are synthetic — invented names on a made-up board. The repo is
 * public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import { WAITING_UNFILED_BUCKET } from '../src/waiting-unfiled.ts';
import {
  LEAD,
  PERSON,
  QUIET_MS,
  listenFrames,
  waitForFrames,
} from './doc-activity-stall-harness.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

/** The agent holding the tasks — not the lead, so the wake has an addressee
 *  that is not also the poster. */
const BUILDER = { id: 'agent-millwright', name: 'Millwright', kind: 'agent' };

/** The sentence the detector has to see, in the third person: the owner's
 *  name comes off the board's own transitions, never from this file. */
const WAIT_TEXT = `Branch is cut and the smoke run is green. Waiting on ${PERSON.name} to pick the release window.`;

describe('a note that says the agent is waiting on a person, with nothing filed', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws: string;
  let lead: ReturnType<typeof listenFrames>;

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'waiting-unfiled-'));
    handle = createServer({ port: 0, dataDir, stallNudgeQuietMs: QUIET_MS });
    base = `http://127.0.0.1:${handle.port}`;
    await seedBoard(base);
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'release-train', leadAgentId: LEAD.id }),
    );
    ws = workspace.id;
    await jj(
      await post(`/workspaces/${ws}/agents`, { agentId: LEAD.id, runtime: 'claude-code-local' }),
    );
    const res = await fetch(
      `${base}/workspaces/${ws}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    lead = listenFrames(res);
  });

  afterEach(async () => {
    await lead.stop();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A task claimed by the builder. The `todo` step is taken BY THE PERSON,
   *  which is also how the board learns who the people are. */
  async function claimedTask(title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${ws}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the train leaves on time.`,
        assignee: BUILDER.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    for (const [to, author] of [
      ['todo', PERSON],
      ['in-progress', BUILDER],
    ] as const) {
      await jj(
        await post(`/workspaces/${ws}/tasks/${task.id}/transition`, {
          to,
          author,
          workspaceId: ws,
        }),
      );
    }
    return task.id;
  }

  /**
   * Wait until every named task has been quiet, on the board's own clock, for
   * longer than the window — polling the store rather than sleeping a guessed
   * duration. Creating a task kicks off background writes (the goal
   * assignment among them) that land after the create returns and bump
   * `updatedAt`; a fixed sleep raced them and the wake read the row as fresh.
   *
   * TWO windows, not one. The gate makes a row a finding after one; the wake
   * spends no turn while every task it would name moved inside the
   * moved-within window, which the wiring derives as twice the quiet window
   * (`stall-frame-news.ts`). A row named at one window is work somebody was
   * on minutes ago.
   */
  const quietPastWindow = (ids: readonly string[]): Promise<unknown> =>
    waitFor(
      () =>
        ids.every((id) => {
          const task = handle.tasks.getTask(id);
          return task !== undefined && Date.now() - task.updatedAt > 2 * QUIET_MS;
        }),
      { describe: 'every task quiet past the moved-within window' },
    );

  const noteOn = (taskId: string, text: string): Promise<Response> =>
    post(`/workspaces/${ws}/tasks/${taskId}/notes`, {
      kind: 'turn',
      text,
      agent: BUILDER.name,
      at: Date.now(),
    });

  it('becomes a waiting-unfiled finding to the lead, while the same note with an item filed does not', async () => {
    const unfiledTask = await claimedTask('Cut the release branch');
    const filedTask = await claimedTask('Draft the rollout note');
    // The control's ask, filed where the person reads it, BEFORE the note —
    // so the only difference between the two tasks is the filing.
    await jj(
      await post(`/workspaces/${ws}/tasks/${filedTask}/review-items`, {
        review: {
          review_type: 'question',
          headline: 'Which release window do you want?',
          detail: 'Tuesday morning or Thursday evening — either works for the train.',
        },
        author: BUILDER,
      }),
    );
    // Past the quiet window with the board untouched, so the only thing that
    // can still move either task's clock is the note each is about to get.
    await quietPastWindow([unfiledTask, filedTask]);
    await noteOn(unfiledTask, WAIT_TEXT);
    await noteOn(filedTask, WAIT_TEXT);

    handle.nudgeStalls();
    const [frame] = await waitForFrames(lead.frames, STALL_EVENT, 1);
    const unfiled = (frame?.data?.unfiled ?? []) as Array<{ id: string; bucket: string }>;
    const stalled = (frame?.data?.rows ?? []) as Array<{ id: string }>;
    expect(unfiled.map((r) => r.id)).toContain(unfiledTask);
    expect(unfiled.find((r) => r.id === unfiledTask)?.bucket).toBe(WAITING_UNFILED_BUCKET);
    // The control: on no list, under any bucket.
    expect(unfiled.map((r) => r.id)).not.toContain(filedTask);
    expect(stalled.map((r) => r.id)).not.toContain(filedTask);
  }, 30_000);

  it('control: a note that only reports progress leaves the task off every list', async () => {
    const reporting = await claimedTask('Tag the build');
    const asking = await claimedTask('Cut the release branch');
    await quietPastWindow([reporting, asking]);
    await noteOn(reporting, 'Tagged the build and pushed it; the smoke run is green.');
    await noteOn(asking, WAIT_TEXT);

    handle.nudgeStalls();
    const [frame] = await waitForFrames(lead.frames, STALL_EVENT, 1);
    const named = [
      ...((frame?.data?.unfiled ?? []) as Array<{ id: string }>),
      ...((frame?.data?.rows ?? []) as Array<{ id: string }>),
    ].map((r) => r.id);
    expect(named).toContain(asking);
    expect(named).not.toContain(reporting);
  }, 30_000);
});
