/**
 * A review item a person asked a question on is OFF that person's queue until
 * its filer revises it — and a reply on the question's thread is not a
 * revision. On 2026-09-09 two items sat off the queue for 38 hours that way:
 * the lead answered in the thread, never revised, and the stall wake it got
 * said only "quiet 1h 46m".
 *
 * The replay below drives that case through a real server — item filed, a
 * person asks back, the filer replies in the thread, nobody revises — and
 * renders the lead's frame with the plugin's own `stalledLine`, so what is
 * asserted is the sentence the lead reads, built from the frame the server
 * really sends. The unit block after it pins the arming: once per question.
 *
 * Every fixture is invented. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type StallPayload, stalledLine } from '../../mcp/src/nudge-line.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { AskedBackRow, StalledRow } from '../src/stall-gate.ts';
import { STALL_EVENT, type StallNudgeFrame, StallNudger } from '../src/stall-nudge.ts';
import { type Frame, listenFrames, settle } from './doc-activity-stall-harness.ts';
import { FILER, LEAD, PERSON } from './review-judge-harness.ts';
import { waitFor } from './wait-for.ts';

/** The quiet window. Real, so "the question is younger than it" is a state
 *  the control can stand in on a loaded box. */
const QUIET_MS = 1_000;

const DECISION = {
  shape: 'decision' as const,
  headline: 'Cache size for the nightly rebuild',
  detail: 'A full pass reads the index once. A smaller cache makes it read twice.',
  options: [
    { id: 'o-keep', label: 'Keep it' },
    { id: 'o-halve', label: 'Halve it' },
  ],
};

describe('the 09-09 replay: a question answered on the thread and never revised', () => {
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
    dataDir = mkdtempSync(join(tmpdir(), 'asked-back-wake-'));
    handle = createServer({
      port: 0,
      dataDir,
      stallNudgeQuietMs: QUIET_MS,
      keepMovingCadenceMs: 0,
    });
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

  /** A board with a lead, an in-progress ticket the filer holds, an item the
   *  filer filed on it, and a person's question asked back at that item. */
  async function askedBackBoard() {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'riverbend-index', leadAgentId: LEAD.id }),
    );
    const workspaceId = workspace.id;
    const lead = await agentStream(workspaceId, LEAD);
    await agentStream(workspaceId, FILER);
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title: 'Rebuild the Riverbend index nightly',
        body: 'Agent can rebuild the index so that search stays fresh.',
        assignee: FILER.name,
        assigneeKind: 'agent',
        author: FILER,
      }),
    );
    for (const to of ['todo', 'in-progress']) {
      await jj(
        await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, { to, author: FILER }),
      );
    }
    const { item } = await jj<{ item: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks/${task.id}/review-items`, {
        review: DECISION,
        author: FILER,
      }),
    );
    const asked = await jj<{ asked?: boolean; threadId: string }>(
      await post(`/workspaces/${workspaceId}/tasks/${task.id}/review-items/${item.id}/answer`, {
        text: 'Why does the cache size matter tonight?',
        author: PERSON,
      }),
    );
    expect(asked.asked).toBe(true);
    return { workspaceId, taskId: task.id, itemId: item.id, threadId: asked.threadId, lead };
  }

  const onQueue = async (workspaceId: string, taskId: string) => {
    const { items } = await jj<{ items: Array<{ taskId?: string; reviewItemId?: string }> }>(
      await fetch(`${base}/workspaces/${workspaceId}/review-items`),
    );
    return items.filter((r) => r.taskId === taskId).map((r) => r.reviewItemId);
  };
  const stallFrames = (frames: Frame[]) => frames.filter((f) => f.event === STALL_EVENT);
  const askedBackOf = (frame: Frame | undefined) =>
    (frame?.data?.askedBack ?? []) as Array<Record<string, unknown>>;

  it('the wake names the item, how long the question has stood, and that only a revision puts it back', async () => {
    const { workspaceId, taskId, itemId, threadId, lead } = await askedBackBoard();
    // The filer's reply, on the question's own thread — what the lead did.
    await jj(
      await post(`/workspaces/${workspaceId}/docs/task:${taskId}/threads/${threadId}/comments`, {
        text: 'It decides whether tonight’s rebuild reads the index once or twice.',
        author: FILER,
      }),
    );
    // Still off the reader's queue: the reply answered nothing the queue reads.
    expect(await onQueue(workspaceId, taskId)).toEqual([]);

    const told = await waitFor(
      () => {
        handle.nudgeStalls();
        return stallFrames(lead.frames).find((f) =>
          askedBackOf(f).some((a) => a.reviewItemId === itemId),
        );
      },
      { timeout: 10_000, interval: 25, describe: 'a stall frame naming the asked-back item' },
    );
    const revise = `revise_review_item(taskId="${taskId}", reviewItemId="${itemId}")`;
    expect(askedBackOf(told)[0]).toMatchObject({
      id: taskId,
      reviewItemId: itemId,
      headline: DECISION.headline,
      askedBy: PERSON.name,
      revise,
    });
    expect(askedBackOf(told)[0]?.askedMs as number).toBeGreaterThan(QUIET_MS);

    const line = stalledLine(told?.data as StallPayload);
    expect(line).toContain(`"${DECISION.headline}"`);
    expect(line).toContain(`(${taskId})`);
    // The question's age, in the renderer's own units.
    expect(line).toMatch(new RegExp(`${PERSON.name} asked \\d+s ago`));
    expect(line).toContain('OFF their queue until revised');
    expect(line).toContain(`off ${PERSON.name}'s queue since, revise with ${revise}`);
    expect(line).toContain(
      'A reply on the thread does not put an item back; only revise_review_item does',
    );

    // Once: a further pass over the same question says nothing more, even
    // after the ticket goes quiet behind it — the same unrevised question.
    // The verdict (recorded every tick here) is the positive control that the
    // ticket really was stalled on the pass that stayed silent.
    await waitFor(
      async () => {
        handle.nudgeStalls();
        const { latest } = await jj<{ latest: { stalled: string[] } | null }>(
          await fetch(`${base}/workspaces/${workspaceId}/keep-moving`),
        );
        return latest?.stalled.includes(taskId);
      },
      { timeout: 10_000, interval: 25, describe: 'the ticket to read as stalled' },
    );
    await settle(100);
    expect(stallFrames(lead.frames)).toHaveLength(1);
  }, 20_000);

  it('a question revised inside the window never reaches the lead as asked back', async () => {
    const { workspaceId, taskId, itemId, lead } = await askedBackBoard();
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        detail: 'It decides whether tonight’s rebuild reads the index once or twice.',
        author: FILER,
      }),
    );
    expect(await onQueue(workspaceId, taskId)).toEqual([itemId]);
    const revisedAt = Date.now();
    await waitFor(() => Date.now() > revisedAt + QUIET_MS, {
      timeout: 5_000,
      interval: 25,
      describe: 'the quiet window to pass',
    });
    handle.nudgeStalls();
    await settle(100);
    expect(stallFrames(lead.frames).filter((f) => askedBackOf(f).length > 0)).toEqual([]);
  }, 20_000);
});

describe('an asked-back item arms the lead’s wake once per question', () => {
  const MIN = 60_000;
  const ASKED: AskedBackRow = {
    id: 't-7',
    title: 'Rebuild the Riverbend index nightly',
    reviewItemId: 'ri-1',
    headline: 'Cache size for the nightly rebuild',
    askedBy: PERSON.name,
    askedAt: 1_000_000 - 25 * MIN,
    askedMs: 25 * MIN,
    revise: 'revise_review_item(taskId="t-7", reviewItemId="ri-1")',
  };

  function harness() {
    const world = {
      now: 1_000_000,
      stalled: [] as StalledRow[],
      askedBack: [ASKED] as AskedBackRow[],
    };
    const sent: StallNudgeFrame[] = [];
    const nudger = new StallNudger({
      now: () => world.now,
      snapshot: () => [
        {
          workspaceId: 'w-riverbend',
          leadAgentId: 'agent-cartographer',
          retired: false,
          stalled: world.stalled,
          unfiled: [],
          considered: 1,
          undetermined: [],
          askedBack: world.askedBack,
        },
      ],
      canReach: () => true,
      send: (_workspaceId, _agentId, frame) => {
        sent.push(frame);
        return 1;
      },
      report: () => {},
    });
    return { world, sent, nudger };
  }

  it('wakes on the question alone, then stays quiet while it stands', () => {
    const { sent, nudger } = harness();
    nudger.tick();
    nudger.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ taskId: 't-7', stalledCount: 0, askedBack: [ASKED] });
  });

  it('does not wake again when the same ticket then goes quiet behind the question', () => {
    const { world, sent, nudger } = harness();
    nudger.tick();
    world.stalled = [{ id: 't-7', title: ASKED.title, bucket: 'in-progress', quietMs: 21 * MIN }];
    nudger.tick();
    expect(sent).toHaveLength(1);
  });

  it('a NEW question on the same item, after a revision, is news', () => {
    const { world, sent, nudger } = harness();
    nudger.tick();
    world.askedBack = [];
    nudger.tick();
    world.askedBack = [{ ...ASKED, askedAt: ASKED.askedAt + 30 * MIN, askedMs: 21 * MIN }];
    nudger.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.changed?.askedBack?.map((a) => a.askedAt)).toEqual([ASKED.askedAt + 30 * MIN]);
  });
});
