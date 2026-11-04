/**
 * An owner check the gate held, revised by its filer, and the line reported
 * again — driven over HTTP against a real server.
 *
 * Two defects reported 2026-11-04 on owner-check items:
 *
 *  1. a hold named sentences of the board's own template, which no revision
 *     the filer makes can change;
 *  2. re-reporting the line wrote the generic card back over the headline and
 *     options the filer had revised to answer a hold.
 *
 * The judge is a stub throughout; the real model is never called. All
 * fixtures are invented — the repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewJudgeVerdict } from '../src/review-judge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';

const BUILDER = { id: 'agent-millwright', name: 'Millwright', kind: 'agent' };
const SHOT = 'https://example.com/phone.png';
const TITLE = 'Reader can see the chart on a phone';
const LINE = 'the chart reads on a phone held sideways';

let handle: ServerHandle | undefined;
let dataDir = '';
let base = '';
let ws = '';
let judge: () => ReviewJudgeVerdict = () => ({ ok: true, reason: 'fine' });

afterEach(async () => {
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

async function fresh(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'owner-revision-'));
  judge = () => ({ ok: true, reason: 'fine' });
  handle = createServer({
    port: 0,
    dataDir,
    keepMovingCadenceMs: 0,
    heldReviewItemMs: 60 * 60_000,
    reviewJudge: async () => judge(),
  });
  base = `http://127.0.0.1:${handle.port}`;
  const res = await post('/workspaces', { name: 'Riverbend board', author: BUILDER });
  ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

async function detail(taskId: string): Promise<Task> {
  const r = await fetch(`${base}/workspaces/${ws}/tasks/${taskId}/detail`);
  return ((await r.json()) as { task: Task }).task;
}

async function lineTask(): Promise<{ taskId: string; lineId: string }> {
  const r = await post(`/workspaces/${ws}/tasks`, {
    author: BUILDER,
    title: TITLE,
    doneWhen: [{ text: LINE }],
  });
  const task = ((await r.json()) as { task: Task }).task;
  return { taskId: task.id, lineId: (await detail(task.id)).doneWhen?.[0]?.id as string };
}

interface ReportBody {
  held?: Array<{ reviewItemId: string; heldReason: string; message: string }>;
}

async function reportOwner(taskId: string, lineId: string): Promise<ReportBody> {
  const r = await post(`/workspaces/${ws}/tasks/${taskId}/done-when/report`, {
    author: BUILDER,
    lines: [{ id: lineId, verdict: 'owner', proof: [{ text: 'the phone shot', url: SHOT }] }],
  });
  expect(r.status).toBe(200);
  return (await r.json()) as ReportBody;
}

describe("a hold on an owner check never names the board's own template", () => {
  it('does not hold for an unstateable concern that quotes the template', async () => {
    await fresh();
    const { taskId, lineId } = await lineTask();
    // A diagnosis with a figure the card never states — so the gate replaces
    // it — quoting the template's own "what each answer does" sentence.
    judge = () => ({
      ok: false,
      reason: 'It takes 45 minutes to see whether the task closes.',
      quote: 'the task closes once every line is',
    });
    const out = await reportOwner(taskId, lineId);
    expect(out.held ?? []).toHaveLength(0);
    const item = (await detail(taskId)).reviews?.[0];
    expect(item?.judge?.verdict).toBe('ok');
  });

  it("drops a template quote from a stateable hold, and keeps one of the line's own words", async () => {
    await fresh();
    const { taskId, lineId } = await lineTask();
    judge = () => ({
      ok: false,
      reason: 'The check does not say which chart.',
      quote: 'Marks this line met.',
    });
    await reportOwner(taskId, lineId);
    const held = (await detail(taskId)).reviews?.[0];
    expect(held?.judge?.verdict).toBe('held');
    expect(held?.judge?.quote).toBeUndefined();

    // The control: the line's own words are the filer's, and may be named.
    await fresh();
    const second = await lineTask();
    judge = () => ({ ok: false, reason: 'The check does not say which chart.', quote: LINE });
    await reportOwner(second.taskId, second.lineId);
    expect((await detail(second.taskId)).reviews?.[0]?.judge?.quote).toBe(LINE);
  });
});

describe('re-reporting an owner line', () => {
  it("keeps the headline and options the filer revised, while the line's words are unchanged", async () => {
    await fresh();
    const { taskId, lineId } = await lineTask();
    judge = () => ({ ok: false, reason: 'The headline does not say what to look at.' });
    const first = await reportOwner(taskId, lineId);
    const itemId = first.held?.[0]?.reviewItemId as string;
    expect(itemId).toBeTruthy();

    // The filer answers the hold by revising the card.
    const headline = 'Check the chart on a phone held sideways';
    const options = [
      { id: 'looks-right', label: 'Reads well', detail: 'Marks this line met.' },
      { id: 'not-met', label: 'Hard to read', detail: 'Sends it back with your words.' },
    ];
    judge = () => ({ ok: true, reason: 'fine' });
    const revised = await post(`/workspaces/${ws}/tasks/${taskId}/review-items/${itemId}/revise`, {
      author: BUILDER,
      headline,
      options,
    });
    expect(revised.status).toBe(200);

    // The same line, the same proof, reported again.
    await reportOwner(taskId, lineId);
    const item = (await detail(taskId)).reviews?.find((r) => r.id === itemId);
    expect(item?.review.headline).toBe(headline);
    expect(item?.review.options?.map((o) => o.label)).toEqual(['Reads well', 'Hard to read']);
  });

  it('still writes the new words when the line itself changed', async () => {
    // The control: a re-report that moves the line's proof is news the card
    // has to carry, so the template is written again.
    await fresh();
    const { taskId, lineId } = await lineTask();
    await reportOwner(taskId, lineId);
    const itemId = (await detail(taskId)).reviews?.[0]?.id as string;
    await post(`/workspaces/${ws}/tasks/${taskId}/review-items/${itemId}/revise`, {
      author: BUILDER,
      headline: 'Check the chart on a phone held sideways',
    });
    const r = await post(`/workspaces/${ws}/tasks/${taskId}/done-when/report`, {
      author: BUILDER,
      lines: [
        {
          id: lineId,
          verdict: 'owner',
          proof: [{ text: 'a newer shot', url: 'https://example.com/phone-2.png' }],
        },
      ],
    });
    expect(r.status).toBe(200);
    const item = (await detail(taskId)).reviews?.find((x) => x.id === itemId);
    expect(item?.review.detail ?? '').toContain('phone-2.png');
  });
});
