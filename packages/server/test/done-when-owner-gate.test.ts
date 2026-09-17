/**
 * A done-when line handed to the owner reaches them only through the quality
 * gate a hand-written item passes, and only with a link to open.
 *
 * The first owner items (2026-09-14) skipped the gate: they shipped with no
 * link, with no ask a reader could act on, and with checks an agent could
 * have read for itself. Driven over HTTP against a real server, read back off
 * the queue route Home renders and the event stream a builder listens on.
 *
 * The judge is a stub throughout; the real model is never called. All
 * fixtures are invented — the repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewJudgeInput, ReviewJudgeVerdict } from '../src/review-judge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { REVIEW_ITEM_HELD_EVENT } from '../src/stall-nudge.ts';
import type { Task } from '../src/tasks.ts';
import { listenFrames, settle, waitForFrames } from './doc-activity-stall-harness.ts';
import { waitFor } from './wait-for.ts';

const PERSON = { id: 'known-reader', name: 'Reader', kind: 'known', color: '#2e7dd7' };
const BUILDER = { id: 'agent-millwright', name: 'Millwright', kind: 'agent' };
/** A second session on the same board — the control for who reads a hold. */
const SCOUT = { id: 'agent-saltmarsh', name: 'Saltmarsh', kind: 'agent' };
const SHOT = 'https://example.com/phone.png';
const SENTRY_REASON = 'An agent can read the error tracker for this alarm itself.';

let handle: ServerHandle | undefined;
let dataDir = '';
let base = '';
let ws = '';
let verdict: ReviewJudgeVerdict = { ok: true, reason: 'fine' };
let judged: ReviewJudgeInput[] = [];
const streams: Array<ReturnType<typeof listenFrames>> = [];

type BootExtra = { heldReleaseMs?: number; publicBaseUrl?: string };

function boot(extra: BootExtra = {}): void {
  handle = createServer({
    port: 0,
    dataDir,
    keepMovingCadenceMs: 0,
    heldReviewItemMs: 60 * 60_000,
    reviewJudge: async (input) => {
      judged.push(input);
      return verdict;
    },
    ...extra,
  });
  base = `http://127.0.0.1:${handle.port}`;
}

afterEach(async () => {
  for (const s of streams.splice(0)) await s.stop();
  await handle?.stop();
  handle = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function fresh(extra: BootExtra = {}): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'owner-gate-'));
  verdict = { ok: true, reason: 'fine' };
  judged = [];
  boot(extra);
  const res = await post('/workspaces', { name: 'Riverbend board', author: BUILDER });
  ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

async function detail(taskId: string): Promise<Task> {
  const r = await fetch(`${base}/workspaces/${ws}/tasks/${taskId}/detail`);
  return ((await r.json()) as { task: Task }).task;
}

async function onQueue(taskId: string): Promise<string[]> {
  const r = await fetch(`${base}/workspaces/${ws}/review-items`);
  const { items } = (await r.json()) as {
    items: Array<{ taskId?: string; reviewItemId?: string }>;
  };
  return items.filter((i) => i.taskId === taskId).map((i) => i.reviewItemId ?? '');
}

async function lineTask(title: string, text: string): Promise<{ taskId: string; lineId: string }> {
  const r = await post(`/workspaces/${ws}/tasks`, { author: BUILDER, title, doneWhen: [{ text }] });
  const task = ((await r.json()) as { task: Task }).task;
  return { taskId: task.id, lineId: (await detail(task.id)).doneWhen?.[0]?.id as string };
}

interface ReportBody {
  error?: string;
  message?: string;
  held?: Array<{ lineId: string; reviewItemId: string; heldReason: string; message: string }>;
}

async function report(
  taskId: string,
  lineId: string,
  verdictName: string,
  proof?: Array<{ text: string; url?: string }>,
  author: { id: string; name: string; kind: string } = BUILDER,
): Promise<{ status: number; body: ReportBody }> {
  const r = await post(`/workspaces/${ws}/tasks/${taskId}/done-when/report`, {
    author,
    lines: [{ id: lineId, verdict: verdictName, ...(proof ? { proof } : {}) }],
  });
  return { status: r.status, body: (await r.json()) as ReportBody };
}

async function builderStream(agentId: string = BUILDER.id) {
  await post(`/workspaces/${ws}/agents`, { agentId, runtime: 'claude-code-local' });
  const res = await fetch(
    `${base}/workspaces/${ws}/events:stream?agentId=${encodeURIComponent(agentId)}`,
    { headers: { accept: 'text/event-stream' } },
  );
  const stream = listenFrames(res);
  streams.push(stream);
  return stream;
}

describe('a line handed to the owner carries a link', () => {
  it('refuses an owner report with no url, naming the line, and writes nothing', async () => {
    await fresh();
    const { taskId, lineId } = await lineTask(
      'Reader can see the chart on a phone',
      'the chart reads at 430 wide',
    );
    const { status, body } = await report(taskId, lineId, 'owner', [{ text: 'looked at it' }]);
    expect(status).toBe(400);
    expect(body.error).toBe('link-required');
    expect(body.message).toContain('the chart reads at 430 wide');
    const after = await detail(taskId);
    expect(after.doneWhen?.[0]?.verdict).toBeUndefined();
    expect(after.reviews ?? []).toHaveLength(0);

    // The control: the same report with a link is filed.
    const linked = await report(taskId, lineId, 'owner', [{ text: 'phone shot', url: SHOT }]);
    expect(linked.status).toBe(200);
    expect(await onQueue(taskId)).toHaveLength(1);
  });

  it("takes a board path as the link, made absolute on the server's public base", async () => {
    await fresh({ publicBaseUrl: 'https://board.example.test' });
    const { taskId, lineId } = await lineTask(
      'Reader can find the export',
      'the export button reads right',
    );
    const path = `/workspaces/${ws}?task=${taskId}`;
    const { status, body } = await report(taskId, lineId, 'owner', [
      { text: 'the task', url: path },
    ]);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    const url = `https://board.example.test${path}`;
    expect((await detail(taskId)).doneWhen?.[0]?.proof?.[0]?.url).toBe(url);
    expect(judged[0]?.item.detail?.startsWith(`Open [the task](${url})`)).toBe(true);
  });
});

describe('an owner check passes the same gate a hand-written item does', () => {
  it('is judged as an owner check, and reaches the queue when it passes', async () => {
    await fresh();
    const { taskId, lineId } = await lineTask(
      'Reader can comment from the phone app',
      "On the reader's phone the app page shows the comment button",
    );
    await report(taskId, lineId, 'owner', [{ text: 'phone shot', url: SHOT }]);
    expect(judged).toHaveLength(1);
    expect(judged[0]?.item.ownerCheck).toBe(true);
    expect(judged[0]?.item.detail?.startsWith(`Open [phone shot](${SHOT})`)).toBe(true);
    expect(await onQueue(taskId)).toHaveLength(1);

    // The control: a hand-written item on the same board is not judged as one.
    const handWritten = await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      author: BUILDER,
      review: {
        shape: 'decision',
        headline: 'Which layout ships on the phone',
        detail: 'Both are built; the release waits on this.',
        options: [
          { id: 'o-1', label: 'Stacked', detail: 'longer scroll' },
          { id: 'o-2', label: 'Tabs', detail: 'one more tap' },
        ],
      },
    });
    expect(handWritten.status).toBe(200);
    expect(judged).toHaveLength(2);
    expect(judged[1]?.item.ownerCheck).toBeUndefined();
  });

  it('held, it stays off the queue and goes back to the builder that marked the line', async () => {
    await fresh();
    const { taskId, lineId } = await lineTask(
      'Reader is not paged for slow loads',
      'No over-budget alarm in the error tracker for 24 hours after the deploy',
    );
    const builder = await builderStream();
    verdict = { ok: false, reason: SENTRY_REASON };
    const { status, body } = await report(taskId, lineId, 'owner', [
      { text: 'the alarm view', url: 'https://example.com/alarms' },
    ]);
    expect(status).toBe(200);
    expect(body.held).toHaveLength(1);
    expect(body.held?.[0]?.lineId).toBe(lineId);
    expect(body.held?.[0]?.heldReason).toBe(SENTRY_REASON);
    expect(body.held?.[0]?.message).toContain('report_done_when(');
    // The whole address is in the reply the builder is already reading: the
    // call that ends the hold names this line. So no frame is pushed at it as
    // well — since 2026-09-17 a hold handed back in its own reply sends none,
    // because a wake is the reader's whole turn and this one would name
    // nothing the caller did not already hold.
    expect(body.held?.[0]?.message).toContain(`id: "${lineId}"`);
    expect(await onQueue(taskId)).toHaveLength(0);
    // A frame would already be on the wire: the send is synchronous with the
    // gate, and the reply above has landed. The control below is what proves
    // this stream carries held frames at all on this board.
    await settle();
    expect(builder.frames.filter((f) => f.event === REVIEW_ITEM_HELD_EVENT)).toEqual([]);

    // The fix the hold asks for: the builder reads it and reports met itself,
    // which the owner rule allows while the check never reached the owner.
    const met = await report(taskId, lineId, 'met', [
      { text: 'no alarm in 24h', url: 'https://example.com/alarms' },
    ]);
    expect(met.status).toBe(200);
    const after = await detail(taskId);
    expect(after.doneWhen?.[0]?.verdict).toBe('met');
    expect(after.status).toBe('done');
    expect(typeof after.reviews?.[0]?.review.withdrawnAt).toBe('number');
  });

  it('MUTATION CONTROL: a hold whose filer is NOT the caller is still pushed', async () => {
    // The rule is "no second copy for a caller who reads the hold in its own
    // reply", not "no held frames". Here a second session reports the same
    // line: the hold still belongs to the builder that marked it, who has no
    // reply of its own to read, so the frame goes exactly as it always did.
    await fresh();
    const { taskId, lineId } = await lineTask(
      'Reader is not paged for slow loads',
      'No over-budget alarm in the error tracker for 24 hours after the deploy',
    );
    const builder = await builderStream();
    await builderStream(SCOUT.id);
    verdict = { ok: false, reason: SENTRY_REASON };
    // The first report records the builder as the item's filer.
    await report(taskId, lineId, 'owner', [{ text: 'the alarm view', url: SHOT }]);
    await settle();
    expect(builder.frames.filter((f) => f.event === REVIEW_ITEM_HELD_EVENT)).toEqual([]);

    // Now a different session touches the same line.
    await report(taskId, lineId, 'owner', [{ text: 'the alarm view', url: SHOT }], SCOUT);

    await waitForFrames(builder.frames, REVIEW_ITEM_HELD_EVENT, 1);
    const frame = builder.frames.find((f) => f.event === REVIEW_ITEM_HELD_EVENT);
    expect(frame?.data?.reason).toBe(SENTRY_REASON);
    expect(String(frame?.data?.revise)).toContain(`id: "${lineId}"`);
  });

  it('still refuses the builder a met on a check that reached the owner', async () => {
    await fresh();
    const { taskId, lineId } = await lineTask('Reader can pin a doc', 'the pin reads right');
    await report(taskId, lineId, 'owner', [{ text: 'shot', url: SHOT }]);
    const met = await report(taskId, lineId, 'met', [{ text: 'I looked', url: SHOT }]);
    expect(met.status).toBe(400);
    expect(met.body.error).toBe('not-yours');
  });

  it('admits the check after two holds, the cap a hand-written item gets', async () => {
    await fresh();
    const { taskId, lineId } = await lineTask('Reader can sort the list', 'the sort holds');
    verdict = { ok: false, reason: 'An agent can load this page itself.' };
    for (const n of [1, 2]) {
      const r = await report(taskId, lineId, 'owner', [{ text: `shot ${n}`, url: SHOT }]);
      expect(r.body.held).toHaveLength(1);
    }
    const third = await report(taskId, lineId, 'owner', [{ text: 'shot 3', url: SHOT }]);
    expect(third.body.held).toBeUndefined();
    expect(await onQueue(taskId)).toHaveLength(1);
  });

  it('a person editing the line re-judges it, and the hold still names the builder', async () => {
    await fresh();
    const { taskId, lineId } = await lineTask('Reader can export', 'the export opens');
    verdict = { ok: false, reason: 'An agent can open the export itself.' };
    await report(taskId, lineId, 'owner', [{ text: 'shot', url: SHOT }]);
    const edited = await post(`/workspaces/${ws}/tasks/${taskId}/done-when`, {
      author: PERSON,
      lines: [{ id: lineId, text: 'the export opens in a sheet' }],
    });
    expect(edited.status).toBe(200);
    expect(judged).toHaveLength(2);
    const held = handle?.tasks.heldReviewItems(ws) ?? [];
    expect(held.map((h) => h.filerAgentId)).toEqual([BUILDER.id]);
  });

  it('an hour unrevised, a held check goes to the reader as filed', async () => {
    await fresh({ heldReleaseMs: 0 });
    const { taskId, lineId } = await lineTask('Reader can rename', 'the new name reads right');
    verdict = { ok: false, reason: 'An agent can read the name back itself.' };
    await report(taskId, lineId, 'owner', [{ text: 'shot', url: SHOT }]);
    expect(await onQueue(taskId)).toHaveLength(0);
    await waitFor(
      async () => {
        handle?.nudgeStalls();
        return (await onQueue(taskId)).length === 1 || undefined;
      },
      { timeout: 10_000, interval: 25, describe: 'the held check released to the queue' },
    );
  });
});

describe('owner items the boot pass files or revises', () => {
  it('are judged too, so a check an agent could read never reaches the queue by a restart', async () => {
    await fresh();
    const { taskId } = await lineTask('Reader can see both projects', 'the watch table lists both');
    await report(taskId, (await detail(taskId)).doneWhen?.[0]?.id as string, 'owner', [
      { text: 'table', url: SHOT },
    ]);
    // Back to the pre-deploy shape: an owner line with no item.
    const live = handle?.tasks.getTask(taskId);
    if (!live) throw new Error('task missing');
    live.reviews = [];
    handle?.tasks.appendNote(taskId, { kind: 'status', text: 'x', agent: 'test', ts: Date.now() });
    await handle?.stop();

    verdict = { ok: false, reason: 'An agent can list the subscriptions itself.' };
    boot();
    await waitFor(() => handle?.tasks.heldReviewItems(ws).length === 1 || undefined, {
      timeout: 10_000,
      interval: 25,
      describe: 'the backfilled item judged and held',
    });
    expect(await onQueue(taskId)).toHaveLength(0);
  });

  it('judge an open item that was never judged, though nothing about its line changed', async () => {
    await fresh();
    const { taskId, lineId } = await lineTask(
      'Both alarms show on the watch table',
      'both alarms list',
    );
    await report(taskId, lineId, 'owner', [{ text: 'table', url: SHOT }]);
    expect(await onQueue(taskId)).toHaveLength(1);
    // Back to an item filed before owner checks were gated, or one a crash
    // left between its write and its judgement: on the queue with no verdict.
    const live = handle?.tasks.getTask(taskId);
    const item = live?.reviews?.[0];
    if (!item) throw new Error('item missing');
    item.judge = undefined;
    handle?.tasks.appendNote(taskId, { kind: 'status', text: 'x', agent: 'test', ts: Date.now() });
    await handle?.stop();

    judged = [];
    verdict = { ok: false, reason: 'An agent can list the alarms itself.' };
    boot();
    await waitFor(() => handle?.tasks.heldReviewItems(ws).length === 1 || undefined, {
      timeout: 10_000,
      interval: 25,
      describe: 'the never-judged item judged and held at boot',
    });
    expect(judged).toHaveLength(1);
    expect(await onQueue(taskId)).toHaveLength(0);
  });
});
