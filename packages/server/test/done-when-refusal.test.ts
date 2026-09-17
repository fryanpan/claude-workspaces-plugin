/**
 * A done-when check the agent was REFUSED permission to run is terminal: the
 * board never answers it with an instruction to obtain the fact another way.
 *
 * The incident (2026-09-16): a lead reported an `owner` line whose proof said
 * the check had been refused by this machine's permission classifier. The
 * quality gate held it twice, and the second hold told the agent it "can work
 * around it by having a separate agent call …" — the product instructing an
 * agent to launder a permission denial. Both hold texts are quoted verbatim
 * below and driven through a stub judge; the real model is never called.
 *
 * The two things this file has to keep apart, because narrowing a gate is one
 * step from disarming it:
 *  - a REFUSED line is never held with a get-it-anyway reason, and reaches
 *    the reader on the first report;
 *  - the SAME reason on a line nobody was refused still holds it, and a
 *    refused line held for a gap its filer can close is still held.
 *
 * All fixtures are invented.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewJudgeInput, ReviewJudgeVerdict } from '../src/review-judge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';

/** The gate's first hold on the refused check, as the lead was given it. */
const FIRST_HOLD =
  'An agent can check this itself: the agent should call GET /v1/models with each API key, compare the organisation identity in the response headers, and verify they differ—this is a fact in API output, not a judgment that needs a person.';

/** Its second, after the lead revised to lead with the denial. */
const SECOND_HOLD =
  'An agent can check this itself: the agent blocked by the classifier can work around it by having a separate agent call GET /v1/models with each key and compare the organisation fields in the response headers—this is API output, a fact not a judgment.';

const BUILDER = { id: 'agent-millwright', name: 'Millwright', kind: 'agent' };
const DENIED = 'Reading the two key slots was refused by this machine’s permission classifier.';
const LOG = 'https://example.com/run-log';

let handle: ServerHandle | undefined;
let dataDir = '';
let base = '';
let ws = '';
let verdict: ReviewJudgeVerdict = { ok: true, reason: 'fine' };
let judged: ReviewJudgeInput[] = [];

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
  dataDir = mkdtempSync(join(tmpdir(), 'refused-check-'));
  verdict = { ok: true, reason: 'fine' };
  judged = [];
  handle = createServer({
    port: 0,
    dataDir,
    keepMovingCadenceMs: 0,
    heldReviewItemMs: 60 * 60_000,
    reviewJudge: async (input) => {
      judged.push(input);
      return verdict;
    },
  });
  base = `http://127.0.0.1:${handle.port}`;
  const res = await post('/workspaces', { name: 'Saltmarsh board', author: BUILDER });
  ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

async function detail(taskId: string): Promise<Task> {
  const r = await fetch(`${base}/workspaces/${ws}/tasks/${taskId}/detail`);
  return ((await r.json()) as { task: Task }).task;
}

async function onQueue(taskId: string): Promise<number> {
  const r = await fetch(`${base}/workspaces/${ws}/review-items`);
  const { items } = (await r.json()) as { items: Array<{ taskId?: string }> };
  return items.filter((i) => i.taskId === taskId).length;
}

async function lineTask(): Promise<{ taskId: string; lineId: string }> {
  const r = await post(`/workspaces/${ws}/tasks`, {
    author: BUILDER,
    title: 'Bryan can tell which key slot paid for a run',
    doneWhen: [{ text: 'the two runs bill to different organisations' }],
  });
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
  proof: Array<{ text: string; url?: string; refused?: boolean }>,
): Promise<{ status: number; body: ReportBody; raw: string }> {
  const r = await post(`/workspaces/${ws}/tasks/${taskId}/done-when/report`, {
    author: BUILDER,
    lines: [{ id: lineId, verdict: 'owner', proof }],
  });
  const raw = await r.text();
  return { status: r.status, body: JSON.parse(raw) as ReportBody, raw };
}

describe('a check the agent was refused permission to run', () => {
  // The words of the refusal, with a link, so only the refusal is under test
  // and not the separate rule that an owner report carries something to open.
  const refusedInWords = [{ text: DENIED, url: LOG }];

  for (const [which, hold] of [
    ['the first hold', FIRST_HOLD],
    ['the laundering hold', SECOND_HOLD],
  ] as const) {
    it(`is never answered with ${which}`, async () => {
      await fresh();
      const { taskId, lineId } = await lineTask();
      verdict = { ok: false, reason: hold };

      const { status, body, raw } = await report(taskId, lineId, refusedInWords);

      expect(status).toBe(200);
      expect(body.held).toBeUndefined();
      // Not merely "no hold": none of those words reach the agent at all.
      expect(raw).not.toContain('separate agent');
      expect(raw).not.toContain('work around');
      expect(raw).not.toContain('An agent can check this itself');
      // And the reader has it, first time of asking.
      expect(await onQueue(taskId)).toBe(1);
      const stored = (await detail(taskId)).reviews?.[0];
      expect(stored?.judge?.verdict).toBe('ok');
      expect(stored?.judge?.reason).not.toContain('separate agent');
      expect(stored?.judge?.reason).toContain('refused permission');
    });
  }

  it('still holds the same line for a gap its filer can close', async () => {
    await fresh();
    const { taskId, lineId } = await lineTask();
    verdict = { ok: false, reason: 'The line does not say what the reader should see there.' };
    const { body } = await report(taskId, lineId, refusedInWords);
    expect(body.held).toHaveLength(1);
    expect(body.held?.[0]?.heldReason).toBe(verdict.reason);
    expect(await onQueue(taskId)).toBe(0);
  });

  it('tells the judge the refusal is terminal, and the reader why it is theirs', async () => {
    await fresh();
    const { taskId, lineId } = await lineTask();
    await report(taskId, lineId, [{ text: DENIED, refused: true }]);
    expect(judged).toHaveLength(1);
    expect(judged[0]?.item.ownerCheck).toBe(true);
    expect(judged[0]?.item.refusedCheck).toBe(true);
    expect(judged[0]?.item.detail).toContain('refused the agent permission');
    expect(judged[0]?.item.detail).toContain(DENIED);
  });
});

describe('the flag that says it, on a check with nothing to open', () => {
  it('is reported once and reaches the reader on the first attempt', async () => {
    await fresh();
    const { taskId, lineId } = await lineTask();
    // What the judge did on the day: a refused check reads exactly like one an
    // agent could make, because it is.
    verdict = { ok: false, reason: SECOND_HOLD };

    const { status, body } = await report(taskId, lineId, [{ text: DENIED, refused: true }]);

    // No `link-required` refusal: a refused check has nothing to link, and
    // demanding one leaves the line unreportable.
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.held).toBeUndefined();
    expect(await onQueue(taskId)).toBe(1);
    const line = (await detail(taskId)).doneWhen?.[0];
    expect(line?.verdict).toBe('owner');
    expect(line?.proof?.[0]?.refused).toBe(true);
  });

  it('does not let an ordinary owner report skip the link rule', async () => {
    await fresh();
    const { taskId, lineId } = await lineTask();
    const { status, body } = await report(taskId, lineId, [{ text: 'looked at it' }]);
    expect(status).toBe(400);
    expect(body.error).toBe('link-required');
    expect(await onQueue(taskId)).toBe(0);
  });
});

describe('a line nobody was refused', () => {
  it('is still held by the same reason, so the gate is narrowed and not disarmed', async () => {
    await fresh();
    const { taskId, lineId } = await lineTask();
    verdict = { ok: false, reason: FIRST_HOLD };
    const { body } = await report(taskId, lineId, [{ text: 'the run log', url: LOG }]);
    expect(body.held).toHaveLength(1);
    expect(body.held?.[0]?.heldReason).toBe(FIRST_HOLD);
    expect(judged[0]?.item.refusedCheck).toBeUndefined();
    expect(await onQueue(taskId)).toBe(0);
  });
});
