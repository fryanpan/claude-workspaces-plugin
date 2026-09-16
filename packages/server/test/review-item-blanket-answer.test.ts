/**
 * One sentence that settles a many-part ask closes the item, and one that
 * settles a single part does not.
 *
 * Written against the measured case (2026-09-16): an item asked about three
 * tips, the reader refused all three in one sentence, and the coverage check
 * named one tip as still unanswered — so the item came back and the reader
 * answered it a second time. The check reads question by question and wants
 * the words that answer each one quoted back; a blanket refusal names none of
 * them.
 *
 * Driven through a real server: the answer route, the store and the queue
 * agreeing. The coverage check is a STUB set to the verdict the live one gave
 * — one part open — so the first case proves the blanket rule decides before
 * the model is asked, and the second proves a genuinely partial answer still
 * reaches it and still holds the item. Every fixture is invented.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnswerCoverageInput } from '../src/answer-coverage.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { FILER, LEAD, PERSON } from './review-judge-harness.ts';

/** Three questions of one kind — the shape a single sentence can settle. */
const THREE_TIPS = {
  shape: 'review' as const,
  headline: 'Three tips for the Riverbend onboarding page',
  detail: [
    '1. Should the page tip readers to rename their first board?',
    '2. Should it tip them to pin the Harborlight view?',
    '3. Should it tip them to turn on Saltmarsh alerts?',
  ].join('\n'),
};

/** What the live check returned for the blanket refusal: the third tip open. */
const ONE_OPEN = { open: ['Should it tip them to turn on Saltmarsh alerts?'] };

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

function boot(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'blanket-answer-'));
  verdict = null;
  calls = [];
  handle = createServer({
    port: 0,
    dataDir,
    keepMovingCadenceMs: 0,
    answerCoverage: async (input: AnswerCoverageInput) => {
      calls.push(input);
      return verdict;
    },
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
    post('/workspaces', { name: 'riverbend-onboarding', leadAgentId: LEAD.id }),
  );
  const { task } = await jj<{ task: { id: string } }>(
    post(`/workspaces/${workspace.id}/tasks`, {
      title: 'Write the Riverbend onboarding page',
      body: 'Agent can write the Riverbend onboarding page so that a new reader knows where to start.',
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

const answer = (ws: string, taskId: string, itemId: string, text: string) =>
  jj<{ item: Item; openParts?: string[] }>(
    post(`/workspaces/${ws}/tasks/${taskId}/review-items/${itemId}/answer`, {
      author: PERSON,
      text,
    }),
  );

async function queueRow(ws: string, itemId: string): Promise<QueueRow | undefined> {
  const { items } = await jj<{ items: QueueRow[] }>(fetch(`${base}/workspaces/${ws}/review-items`));
  return items.find((r) => r.kind === 'task-review' && r.reviewItemId === itemId);
}

describe('an answer that refuses or accepts the whole ask at once', () => {
  it('closes a three-part item and leaves the queue, without asking the model', async () => {
    boot();
    const { ws, taskId, itemId } = await fileItem(THREE_TIPS);

    // The verdict the live check gave for this very reply: one tip open.
    verdict = ONE_OPEN;
    const given = await answer(ws, taskId, itemId, "No, don't give these tips.");

    expect(given.item.answer?.text).toBe("No, don't give these tips.");
    expect(given.openParts).toBeUndefined();
    expect(given.item.partialAnswers ?? []).toEqual([]);
    expect(await queueRow(ws, itemId)).toBeUndefined();
    // Decided before the call, so the reply never reached the model at all.
    expect(calls).toEqual([]);
  });

  it('still holds the item when the answer settles only one of the three', async () => {
    boot();
    const { ws, taskId, itemId } = await fileItem(THREE_TIPS);

    verdict = {
      open: [
        'Should it tip them to pin the Harborlight view?',
        'Should it tip them to turn on Saltmarsh alerts?',
      ],
    };
    const given = await answer(ws, taskId, itemId, 'Tip them to rename their first board.');

    expect(given.item.answer).toBeUndefined();
    expect(given.openParts).toEqual(verdict.open);
    expect(calls.at(-1)?.answers).toEqual(['Tip them to rename their first board.']);

    const row = await queueRow(ws, itemId);
    expect(row).toBeDefined();
    expect(row?.review?.detail).toContain('Still open');
    expect(row?.review?.detail).toContain('Should it tip them to pin the Harborlight view?');
    expect(row?.review?.detail).toContain('Should it tip them to turn on Saltmarsh alerts?');

    // And the blanket reply closes what is left, in one sentence.
    const closed = await answer(ws, taskId, itemId, 'None of them.');
    expect(closed.item.answer?.text).toBe('None of them.');
    expect(await queueRow(ws, itemId)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
