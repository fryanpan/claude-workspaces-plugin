/**
 * The lifted-blockage finding, wired: a row whose answer is already in and
 * which nothing has touched since is named in the lead's stall frame and
 * counted on the verdict's `unresumed` line.
 *
 * Through a real server because the decision is assembled in three places the
 * unit suite next door cannot reach — the task store answers what was
 * answered and which done-when lines are met, the doc store answers whether a
 * comment-borne item carries an answer, and the classifier answers how long
 * the row has been quiet. `blockage-lift.test.ts` can only prove what the
 * reading does with facts it was handed.
 *
 * THE CONTROLS ARE THE POINT OF THIS FILE as much as the two positives are.
 * The failure this finding is built from is a task whose person answered and
 * whose work then sat for 21 hours; the shape it must not name is a task
 * whose answer landed and whose work restarted a minute later, which from the
 * outside is the same two facts in the same order. Every control here differs
 * from a positive by exactly ONE input:
 *
 *   the connector timeline   the positive, plus one note after the answer
 *   completion               every done-when line met instead of the first
 *   the last line met        the met line moved to the end of the list
 *
 * The board carries a BEACON row — quiet, untouched, on no lift — so a
 * silence assertion has something to prove the tick ran and the frame was
 * built. Without it "no frame named the row" and "no frame arrived at all"
 * read identically, and only the second is a broken test.
 *
 * No fixed waits: every wait here is a `waitFor` poll on an observable the
 * server produces, so the file adds nothing to the suite's wait budget.
 *
 * Every fixture is invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIFT_CLOCK_EPSILON_MS } from '../src/blockage-lift.ts';
import type { KeepMovingVerdict } from '../src/keep-moving-verdict.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import { type Frame, QUIET_MS, listenFrames } from './doc-activity-stall-harness.ts';
import { FILER, LEAD, PERSON } from './review-judge-harness.ts';
import { waitFor } from './wait-for.ts';

/**
 * How long after the answer the connector control's work landed.
 *
 * DERIVED from the tolerance it has to clear rather than written as a round
 * number: the epsilon is what separates the lift's own row edit from somebody
 * else's, so a control proving "the row moved after the lift" must sit
 * outside it by a margin nothing about machine speed can close. The real
 * timeline it stands for is 61 seconds; this is the same fact compressed.
 */
const WORK_AFTER_LIFT_MS = LIFT_CLOCK_EPSILON_MS * 2 + 100;

describe('a row whose blockage lifted with nothing done since is the lead’s finding', () => {
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
    dataDir = mkdtempSync(join(tmpdir(), 'unresumed-'));
    // No judge: every item this suite files is admitted, so a hold can never
    // stand in for the finding under test.
    handle = createServer({ port: 0, dataDir, keepMovingCadenceMs: 0, stallNudgeQuietMs: QUIET_MS });
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

  /** One row the FILER agent filed and then took, in progress. */
  async function row(workspaceId: string, title: string, body: string): Promise<string> {
    const { task } = await jj<{ task: { id: string; status: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title,
        body,
        assignee: FILER.name,
        assigneeKind: 'agent',
        author: FILER,
      }),
    );
    const steps = task.status === 'todo' ? ['in-progress'] : ['todo', 'in-progress'];
    for (const to of steps)
      await jj(
        await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, { to, author: FILER }),
      );
    return task.id;
  }

  /**
   * A board, its BEACON row, and the row under test.
   *
   * The beacon exists so that a silence assertion has a positive control
   * riding on the same snapshot: it is quiet, on no lift, and therefore
   * always stalled once the window passes, so a frame naming it proves the
   * tick ran and the wake was built and delivered.
   */
  async function board(): Promise<{ workspaceId: string; taskId: string; beaconId: string }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'atlas', leadAgentId: LEAD.id }),
    );
    await jj(
      await post(`/workspaces/${workspace.id}/agents`, {
        agentId: FILER.id,
        runtime: 'claude-code-local',
      }),
    );
    const beaconId = await row(
      workspace.id,
      'Agent can retire a stale index shard',
      'Agent can drop a shard nobody reads so that the rebuild finishes sooner.',
    );
    const taskId = await row(
      workspace.id,
      'Agent can rebuild the Riverbend index nightly',
      'Agent can refresh the index on a schedule so that search stays current.',
    );
    return { workspaceId: workspace.id, taskId, beaconId };
  }

  /** File one decision on the row and answer it. Returns when it was answered
   *  — by the server's own record of it, which is what the lift reads. */
  async function askAndAnswer(workspaceId: string, taskId: string): Promise<number> {
    const { item } = await jj<{ item: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        review: {
          shape: 'decision',
          headline: 'Which key should the nightly rebuild sort on?',
          detail:
            'At stake: every search on the board reads this order. Blocked until answered: the rebuild.',
          options: [
            { id: 'o-1', label: 'The existing key', detail: 'no migration, the old skew stays' },
            { id: 'o-2', label: 'A fresh key', detail: 'one migration, the skew goes' },
          ],
        },
        author: FILER,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${item.id}/answer`, {
        text: 'A fresh key',
        author: PERSON,
      }),
    );
    const detail = await jj<{
      task: { reviews?: Array<{ id: string; answer?: { ts: number } }> };
    }>(await fetch(`${base}/workspaces/${workspaceId}/tasks/${taskId}/detail`));
    const answeredAt = (detail.task.reviews ?? []).find((r) => r.id === item.id)?.answer?.ts;
    if (answeredAt === undefined) throw new Error('the answer carried no timestamp');
    return answeredAt;
  }

  /** Put `texts` on the row as its done-when lines; answers their ids. */
  async function doneWhen(
    workspaceId: string,
    taskId: string,
    texts: readonly string[],
  ): Promise<string[]> {
    const { lines } = await jj<{ lines: Array<{ id: string }> }>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/done-when`, {
        lines: texts.map((text) => ({ text })),
        author: FILER,
      }),
    );
    return lines.map((l) => l.id);
  }

  /** Report those line ids met, with a proof apiece. */
  async function reportMet(
    workspaceId: string,
    taskId: string,
    ids: readonly string[],
  ): Promise<void> {
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/done-when/report`, {
        lines: ids.map((id) => ({
          id,
          verdict: 'met',
          proof: [{ text: 'bun test index-rebuild.test.ts — 4 pass' }],
        })),
        author: FILER,
      }),
    );
  }

  const stallFrames = (frames: Frame[]) => frames.filter((f) => f.event === STALL_EVENT);
  const unresumedOf = (frame: Frame | undefined) =>
    (frame?.data?.unresumed ?? []) as Array<Record<string, unknown>>;
  const stalledIdsOf = (frame: Frame | undefined) =>
    ((frame?.data?.rows ?? []) as Array<{ id: string }>).map((r) => r.id);

  const latestVerdict = async (workspaceId: string) =>
    jj<{ latest: KeepMovingVerdict | null }>(
      await fetch(`${base}/workspaces/${workspaceId}/keep-moving`),
    );

  /** The frame that names the row as unresumed. */
  const waitForFinding = (lead: { frames: Frame[] }, taskId: string) =>
    waitFor(
      () => {
        handle.nudgeStalls();
        return stallFrames(lead.frames).find((f) =>
          unresumedOf(f).some((r) => r.id === taskId),
        );
      },
      { timeout: 10_000, interval: 25, describe: 'a stall frame naming the unresumed row' },
    );

  /**
   * Prove the tick ran, then prove it said nothing about `taskId`.
   *
   * The beacon is the positive control: a frame naming it as stalled is a
   * frame the wake actually built and delivered, so an empty `unresumed` on
   * it is silence rather than absence.
   */
  const expectSilence = async (
    lead: { frames: Frame[] },
    workspaceId: string,
    beaconId: string,
    taskId: string,
  ) => {
    const told = await waitFor(
      () => {
        handle.nudgeStalls();
        return stallFrames(lead.frames).find((f) => stalledIdsOf(f).includes(beaconId));
      },
      { timeout: 10_000, interval: 25, describe: 'a stall frame naming the beacon row' },
    );
    expect(unresumedOf(told).map((r) => r.id)).not.toContain(taskId);
    for (const f of stallFrames(lead.frames))
      expect(unresumedOf(f).map((r) => r.id)).not.toContain(taskId);
    const { latest } = await latestVerdict(workspaceId);
    expect(latest?.unresumed ?? []).not.toContain(taskId);
  };

  it('names a row whose answer is in and whose work never restarted', async () => {
    // The 21-hour shape, compressed to the board's own quiet window: the ask
    // was filed, the person answered it, and nothing on the row has moved
    // since. Nobody read the answer as the moment the work could start again.
    const { workspaceId, taskId } = await board();
    const answeredAt = await askAndAnswer(workspaceId, taskId);
    const lead = await agentStream(workspaceId, LEAD);

    const told = await waitForFinding(lead, taskId);
    const found = unresumedOf(told).find((r) => r.id === taskId);
    expect(found).toMatchObject({
      id: taskId,
      bucket: 'in-progress',
      lift: 'review-item-answered',
      liftedAt: answeredAt,
      what: 'Which key should the nightly rebuild sort on?',
    });
    // It names the event and its stamp, so a reader can check the finding
    // against the board rather than take its word.
    expect(found?.next).toBeUndefined();
    expect(found?.liftedMs as number).toBeGreaterThan(QUIET_MS);

    const { latest } = await latestVerdict(workspaceId);
    expect(latest?.verdict).toBe('FAIL');
    expect(latest?.unresumed).toContain(taskId);
  }, 20_000);

  it('names a row whose done-when line went met with a later line still open', async () => {
    const { workspaceId, taskId } = await board();
    const [first] = await doneWhen(workspaceId, taskId, [
      'The nightly rebuild runs on its own.',
      'Search reads the fresh index.',
      'The old index is retired.',
    ]);
    if (first === undefined) throw new Error('the row took no done-when lines');
    await reportMet(workspaceId, taskId, [first]);
    const lead = await agentStream(workspaceId, LEAD);

    const told = await waitForFinding(lead, taskId);
    expect(unresumedOf(told).find((r) => r.id === taskId)).toMatchObject({
      id: taskId,
      lift: 'done-when-met',
      what: 'The nightly rebuild runs on its own.',
      // What the work restarts ON — the first line still open after the met
      // one, not merely "there is more to do".
      next: 'Search reads the fresh index.',
    });

    const { latest } = await latestVerdict(workspaceId);
    expect(latest?.verdict).toBe('FAIL');
    expect(latest?.unresumed).toContain(taskId);
  }, 20_000);

  it('says nothing about a row whose work landed after the answer', async () => {
    // THE CONNECTOR TIMELINE, and the control this whole reading is shaped
    // by. One input differs from the first case: a single note, stamped
    // clear of the epsilon after the answer. The row's answer is just as old
    // and just as answered; the difference is that somebody acted on it.
    const { workspaceId, taskId, beaconId } = await board();
    const answeredAt = await askAndAnswer(workspaceId, taskId);
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/notes`, {
        agent: FILER.name,
        kind: 'status',
        text: 'Took the fresh key. Migration written, rebuild running against it.',
        at: answeredAt + WORK_AFTER_LIFT_MS,
      }),
    );
    const lead = await agentStream(workspaceId, LEAD);
    await expectSilence(lead, workspaceId, beaconId, taskId);
  }, 20_000);

  it('says nothing about a row whose last open line just went met', async () => {
    // COMPLETION IS NOT A RESUMED BLOCKAGE. Every line met: the ticket is
    // finishing, there is no next step for anybody to restart, and naming it
    // would turn the moment work COMPLETES into a wake.
    const { workspaceId, taskId, beaconId } = await board();
    const ids = await doneWhen(workspaceId, taskId, [
      'The nightly rebuild runs on its own.',
      'Search reads the fresh index.',
    ]);
    await reportMet(workspaceId, taskId, ids);
    const lead = await agentStream(workspaceId, LEAD);
    await expectSilence(lead, workspaceId, beaconId, taskId);
  }, 20_000);

  it('says nothing about the LAST line going met while earlier lines are open', async () => {
    // The same rule isolated from the board's auto-close, which takes a
    // fully-met ticket off the open set and would carry the case above on its
    // own. Here the row stays in-progress and quiet — the gate names it
    // STALLED on the very frame that leaves it off `unresumed`, which is what
    // makes this a reading about the lines rather than about the row.
    const { workspaceId, taskId, beaconId } = await board();
    const ids = await doneWhen(workspaceId, taskId, [
      'The nightly rebuild runs on its own.',
      'Search reads the fresh index.',
      'The old index is retired.',
    ]);
    const last = ids[ids.length - 1];
    if (last === undefined) throw new Error('the row took no done-when lines');
    await reportMet(workspaceId, taskId, [last]);
    const lead = await agentStream(workspaceId, LEAD);
    await expectSilence(lead, workspaceId, beaconId, taskId);

    const told = stallFrames(lead.frames).find((f) => stalledIdsOf(f).includes(taskId));
    expect(told).toBeDefined();
    const { latest } = await latestVerdict(workspaceId);
    expect(latest?.stalled).toContain(taskId);
    expect(latest?.unresumed ?? []).not.toContain(taskId);
  }, 20_000);
});
