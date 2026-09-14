/**
 * An item that asks several things, answered on one of them, stays on the
 * reader's queue naming what is left — and answering the rest closes it.
 *
 * Written against the measured case (2026-09-14): three questions in one
 * item, the reader answered the first, the item closed, and the other two
 * waited on the reader with nothing on the reader's queue.
 *
 * Driven through a real server: the partial answer is the answer route, the
 * store, the queue and the event log agreeing. The coverage check is a STUB
 * whose verdict each case sets; the real API is never called. Every fixture
 * is invented.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionAnsweredLine } from '../../mcp/src/decision-line.ts';
import { type NudgePayload, reviewAnsweredLine } from '../../mcp/src/nudge-line.ts';
import type { AnswerCoverageInput } from '../src/answer-coverage.ts';
import { REVIEW_ANSWERED_EVENT } from '../src/ready-nudge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { eventsLogPath } from '../src/tasks.ts';
import { FILER, LEAD, PERSON } from './review-judge-harness.ts';
import { listenFrames } from './sse-frames.ts';
import { waitFor } from './wait-for.ts';

const THREE_QUESTIONS = {
  shape: 'review' as const,
  headline: 'Three things before the nightly export ships',
  detail: [
    '1. Should the export run at 02:00 or 04:00?',
    '2. Should archived rows be included?',
    '3. Who gets the failure alert?',
  ].join('\n'),
};

interface Item {
  id: string;
  answer?: { text: string; ts: number };
  partialAnswers?: Array<{ text: string; open: string[] }>;
}
interface QueueRow {
  kind?: string;
  reviewItemId?: string;
  review?: { detail?: string };
}

let handle: ServerHandle | undefined;
let dataDir = '';
let base = '';
let verdict: { open: string[] } | null = null;
let calls: AnswerCoverageInput[] = [];

function boot(coverage = true): void {
  dataDir = mkdtempSync(join(tmpdir(), 'partial-answer-'));
  verdict = null;
  calls = [];
  handle = createServer({
    port: 0,
    dataDir,
    keepMovingCadenceMs: 0,
    ...(coverage
      ? {
          answerCoverage: async (input: AnswerCoverageInput) => {
            calls.push(input);
            return verdict;
          },
        }
      : {}),
  });
  base = `http://127.0.0.1:${handle.port}`;
}

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
const jj = async <T>(res: Response | Promise<Response>): Promise<T> => {
  const r = await res;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};

async function fileItem(review: unknown): Promise<{ ws: string; taskId: string; itemId: string }> {
  const { workspace } = await jj<{ workspace: { id: string } }>(
    post('/workspaces', { name: 'nightly-export', leadAgentId: LEAD.id }),
  );
  const { task } = await jj<{ task: { id: string } }>(
    post(`/workspaces/${workspace.id}/tasks`, {
      title: 'Ship the nightly export',
      body: 'Agent can ship the nightly export so that the warehouse is fresh by morning.',
      assignee: FILER.name,
      assigneeKind: 'agent',
      author: FILER,
    }),
  );
  const { item } = await jj<{ item: { id: string } }>(
    post(`/workspaces/${workspace.id}/tasks/${task.id}/review-items`, { review, author: FILER }),
  );
  return { ws: workspace.id, taskId: task.id, itemId: item.id };
}

const answer = (ws: string, taskId: string, itemId: string, body: Record<string, unknown>) =>
  jj<{ item: Item; openParts?: string[] }>(
    post(`/workspaces/${ws}/tasks/${taskId}/review-items/${itemId}/answer`, {
      author: PERSON,
      ...body,
    }),
  );

async function queueRow(ws: string, itemId: string): Promise<QueueRow | undefined> {
  const { items } = await jj<{ items: QueueRow[] }>(fetch(`${base}/workspaces/${ws}/review-items`));
  return items.find((r) => r.kind === 'task-review' && r.reviewItemId === itemId);
}

function answeredRows(ws: string): Array<Record<string, unknown>> {
  return readFileSync(eventsLogPath(dataDir, ws), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.event === 'decision.answered');
}

describe('an answer that covers only some of an item’s questions', () => {
  it('keeps the item on the queue, names what is left, and closes when the rest is answered', async () => {
    boot();
    const { ws, taskId, itemId } = await fileItem(THREE_QUESTIONS);

    verdict = { open: ['Should archived rows be included?', 'Who gets the failure alert?'] };
    const first = await answer(ws, taskId, itemId, { text: 'Run it at 04:00.' });
    expect(first.item.answer).toBeUndefined();
    expect(first.openParts).toEqual(verdict.open);
    expect(calls.at(-1)?.answers).toEqual(['Run it at 04:00.']);

    // Still on the queue, and the card's own body says which parts are open.
    const row = await queueRow(ws, itemId);
    expect(row).toBeDefined();
    expect(row?.review?.detail).toContain('Still open');
    expect(row?.review?.detail).toContain('Who gets the failure alert?');
    expect(row?.review?.detail).toContain('Run it at 04:00.');
    // The item's own words are kept below the note, unchanged.
    expect(row?.review?.detail).toContain(THREE_QUESTIONS.detail);

    // The filer hears the answer AND what is still open.
    const partialRow = answeredRows(ws).at(-1);
    expect(partialRow?.openParts).toEqual(verdict.open);
    expect(decisionAnsweredLine(partialRow ?? {})).toContain('Who gets the failure alert?');

    // The rest is answered: judged together with the first answer, and closed.
    verdict = { open: [] };
    const second = await answer(ws, taskId, itemId, {
      text: 'Leave archived rows out; alert the on-call.',
    });
    expect(calls.at(-1)?.answers).toEqual([
      'Run it at 04:00.',
      'Leave archived rows out; alert the on-call.',
    ]);
    expect(second.item.answer?.text).toBe('Leave archived rows out; alert the on-call.');
    expect(second.item.partialAnswers?.[0]?.text).toBe('Run it at 04:00.');
    expect(await queueRow(ws, itemId)).toBeUndefined();
    expect(answeredRows(ws).at(-1)?.openParts).toBeUndefined();

    // The answer-time ledger records the ask once, when it closed — not at the
    // partial answer, which would count an open ask as answered.
    const ledger = join(dataDir, 'review-answers.jsonl');
    const recorded = () =>
      (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n') : [])
        .filter((l) => l.includes(`task-review:${taskId}:${itemId}`))
        .map((l) => JSON.parse(l) as { answeredAt: number });
    const closedAt = second.item.answer?.ts;
    await waitFor(() => recorded().some((r) => r.answeredAt === closedAt), {
      describe: 'the answer-time record of the close',
    });
    expect(recorded()).toHaveLength(1);
  });

  it('wakes the lead with the questions still open', async () => {
    boot();
    const { ws, taskId, itemId } = await fileItem(THREE_QUESTIONS);
    await jj(post(`/workspaces/${ws}/agents`, { agentId: LEAD.id, runtime: 'claude-code-local' }));
    const lead = listenFrames(
      await fetch(`${base}/workspaces/${ws}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`, {
        headers: { accept: 'text/event-stream' },
      }),
    );
    try {
      verdict = { open: ['Who gets the failure alert?'] };
      await answer(ws, taskId, itemId, { text: 'Run it at 04:00; include archived rows.' });
      const wake = () => lead.frames.find((f) => f.event === REVIEW_ANSWERED_EVENT);
      await waitFor(() => wake() !== undefined, { describe: 'the review_answered frame' });
      expect(wake()?.data?.openParts).toEqual(['Who gets the failure alert?']);
      expect(reviewAnsweredLine(wake()?.data as NudgePayload)).toContain(
        'PARTIAL: still open on the reader\'s queue: "Who gets the failure alert?"',
      );
    } finally {
      await lead.stop();
    }
  });

  it('a check that cannot answer closes the item, as an answer always did', async () => {
    boot();
    const { ws, taskId, itemId } = await fileItem(THREE_QUESTIONS);
    verdict = null;
    const res = await answer(ws, taskId, itemId, { text: 'Run it at 04:00.' });
    expect(calls).toHaveLength(1);
    expect(res.item.answer?.text).toBe('Run it at 04:00.');
    expect(await queueRow(ws, itemId)).toBeUndefined();
  });

  it('no check wired closes the item without asking', async () => {
    boot(false);
    const { ws, taskId, itemId } = await fileItem(THREE_QUESTIONS);
    const res = await answer(ws, taskId, itemId, { text: 'Run it at 04:00.' });
    expect(res.item.answer?.text).toBe('Run it at 04:00.');
  });
});

describe('answers the check leaves alone', () => {
  it('an item asking one thing is never checked', async () => {
    boot();
    const { ws, taskId, itemId } = await fileItem({
      shape: 'review',
      headline: 'Run the nightly export at 04:00',
      detail: 'Is 04:00 late enough for the warehouse load to have finished?',
    });
    verdict = { open: ['anything'] };
    const res = await answer(ws, taskId, itemId, { text: 'Yes, 04:00 is fine.' });
    expect(calls).toHaveLength(0);
    expect(res.item.answer?.text).toBe('Yes, 04:00 is fine.');
  });

  it('a tapped option answers the item it was offered for', async () => {
    boot();
    const { ws, taskId, itemId } = await fileItem({
      shape: 'decision',
      headline: 'When should the nightly export run?',
      detail: 'Should it run before the warehouse load? Or after, which delays the morning report?',
      options: [
        { id: 'o-early', label: '02:00', detail: 'before the load; may read stale rows' },
        { id: 'o-late', label: '04:00', detail: 'after the load; report lands an hour later' },
      ],
    });
    verdict = { open: ['anything'] };
    const res = await answer(ws, taskId, itemId, { text: '04:00', answeredWith: 'o-late' });
    expect(calls).toHaveLength(0);
    expect(res.item.answer?.text).toBe('04:00');
  });
});
