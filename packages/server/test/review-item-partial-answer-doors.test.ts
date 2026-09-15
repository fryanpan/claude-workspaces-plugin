/**
 * The other doors an answer comes through: an item declared on a comment
 * (its answer route and a plain reply folded into an answer), and a spoken
 * answer. Each keeps an item that asks several things open when only some of
 * them are answered, exactly as the ticket route does
 * (`review-item-partial-answer.test.ts`).
 *
 * Driven through a real server. The coverage check is a STUB whose verdict
 * each case sets, and the voice classifier is stubbed at its seam; no model is
 * called. Every fixture is invented.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnswerCoverageInput } from '../src/answer-coverage.ts';
import { REVIEW_ANSWERED_EVENT } from '../src/ready-nudge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
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
const OPEN = ['Should archived rows be included?', 'Who gets the failure alert?'];

interface Payload {
  answeredAt?: number;
  answerText?: string;
  partialAnswers?: Array<{ text: string; open: string[] }>;
}
interface StoredThread {
  id: string;
  comments: Array<{ id: string; text: string; review?: Payload }>;
}

let handle: ServerHandle | undefined;
let dataDir = '';
let base = '';
let verdict: { open: string[] } | null = null;
let calls: AnswerCoverageInput[] = [];
let classification = '';
let classified = 0;
/** When set, the check answers only once this settles. */
let gate: Promise<void> | undefined;

function boot(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'partial-answer-doors-'));
  verdict = null;
  calls = [];
  classified = 0;
  gate = undefined;
  handle = createServer({
    port: 0,
    dataDir,
    keepMovingCadenceMs: 0,
    answerCoverage: async (input: AnswerCoverageInput) => {
      calls.push(input);
      await gate;
      return verdict;
    },
    voiceComplete: async () => {
      classified++;
      return classification;
    },
  });
  base = `http://127.0.0.1:${handle.port}`;
}

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

// The voice route is trusted-local, so every request names a local host.
const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: `localhost:${handle?.port}` },
    body: JSON.stringify(body),
  });
const jj = async <T>(res: Response | Promise<Response>): Promise<T> => {
  const r = await res;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};

async function board(): Promise<string> {
  const { workspace } = await jj<{ workspace: { id: string } }>(
    post('/workspaces', { name: 'nightly-export', leadAgentId: LEAD.id }),
  );
  return workspace.id;
}

/** A markdown doc on the board, carrying one item declared on a comment. */
async function declareOnDoc(
  ws: string,
): Promise<{ docId: string; threadId: string; commentId: string }> {
  const file = join(dataDir, 'export-plan.md');
  writeFileSync(file, '# Export plan\n\nThe nightly export.\n');
  const { docId } = await jj<{ docId: string }>(
    post(`/workspaces/${ws}/docs`, { docId: 'export-plan', type: 'markdown', sourceUrl: file }),
  );
  await jj(post(`/workspaces/${ws}/docs:attach`, { docId }));
  const { thread } = await jj<{ thread: StoredThread }>(
    post(`/workspaces/${ws}/docs/${docId}/threads`, {
      author: FILER,
      text: 'Three things before this ships.',
      anchor: { kind: 'subject' },
      review: THREE_QUESTIONS,
    }),
  );
  return { docId, threadId: thread.id, commentId: thread.comments[0]?.id ?? '' };
}

async function declaration(
  ws: string,
  docId: string,
  threadId: string,
): Promise<Payload | undefined> {
  const { threads } = await jj<{ threads: StoredThread[] }>(
    fetch(`${base}/workspaces/${ws}/docs/${docId}/threads`),
  );
  return threads.find((t) => t.id === threadId)?.comments[0]?.review;
}

async function queueDetail(ws: string, threadId: string): Promise<string | undefined> {
  const { items } = await jj<{ items: Array<{ threadId?: string; review?: { detail?: string } }> }>(
    fetch(`${base}/workspaces/${ws}/review-items`),
  );
  const row = items.find((r) => r.threadId === threadId);
  return row ? (row.review?.detail ?? '') : undefined;
}

describe('an item declared on a comment, answered on some of its questions', () => {
  it('stays on the queue naming what is left, tells the filer and the lead, and a reply answering the rest closes it', async () => {
    boot();
    const ws = await board();
    const { docId, threadId, commentId } = await declareOnDoc(ws);
    await jj(post(`/workspaces/${ws}/agents`, { agentId: LEAD.id, runtime: 'claude-code-local' }));
    const lead = listenFrames(
      await fetch(`${base}/workspaces/${ws}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`, {
        headers: { accept: 'text/event-stream' },
      }),
    );
    const doc = listenFrames(
      await fetch(`${base}/workspaces/${ws}/docs/${encodeURIComponent(docId)}/events:stream`, {
        headers: { accept: 'text/event-stream' },
      }),
    );
    try {
      verdict = { open: OPEN };
      const first = await jj<{ openParts?: string[] }>(
        post(`/workspaces/${ws}/docs/${docId}/threads/${threadId}/answer`, {
          author: PERSON,
          commentId,
          text: 'Run it at 04:00.',
        }),
      );
      expect(first.openParts).toEqual(OPEN);
      const partial = await declaration(ws, docId, threadId);
      expect(partial?.answeredAt).toBeUndefined();
      expect(partial?.partialAnswers?.map((p) => p.text)).toEqual(['Run it at 04:00.']);

      const detail = await queueDetail(ws, threadId);
      expect(detail).toContain('Still open');
      expect(detail).toContain('Who gets the failure alert?');
      expect(detail).toContain(THREE_QUESTIONS.detail);

      // The filer watching the doc, and the lead, each hear what is left.
      const replied = () =>
        doc.frames.find((f) => f.event === 'thread.replied' && f.data?.openParts !== undefined);
      await waitFor(() => replied() !== undefined, { describe: 'the partial reply frame' });
      expect(replied()?.data?.openParts).toEqual(OPEN);
      const wake = () => lead.frames.find((f) => f.event === REVIEW_ANSWERED_EVENT);
      await waitFor(() => wake() !== undefined, { describe: 'the review_answered frame' });
      expect(wake()?.data?.openParts).toEqual(OPEN);

      // A plain reply answering one more: still open, naming only the last.
      verdict = { open: ['Who gets the failure alert?'] };
      await jj(
        post(`/workspaces/${ws}/docs/${docId}/threads/${threadId}/comments`, {
          author: PERSON,
          text: 'Leave archived rows out.',
        }),
      );
      const second = await declaration(ws, docId, threadId);
      expect(second?.answeredAt).toBeUndefined();
      expect(second?.partialAnswers?.map((p) => p.open)).toEqual([
        OPEN,
        ['Who gets the failure alert?'],
      ]);
      expect(await queueDetail(ws, threadId)).toContain(
        'answered “Leave archived rows out.” — not yet answered:\n\n- Who gets the failure alert?\n\n',
      );

      // A plain reply answering the rest: judged with the earlier answers, closes.
      verdict = { open: [] };
      const closeStart = Date.now();
      await jj(
        post(`/workspaces/${ws}/docs/${docId}/threads/${threadId}/comments`, {
          author: PERSON,
          text: 'Alert the on-call.',
        }),
      );
      expect(calls.at(-1)?.answers).toEqual([
        'Run it at 04:00.',
        'Leave archived rows out.',
        'Alert the on-call.',
      ]);
      const closed = await declaration(ws, docId, threadId);
      expect(closed?.answerText).toBe('Alert the on-call.');
      expect(await queueDetail(ws, threadId)).toBeUndefined();

      // The answer-time ledger records the ask once, at the close.
      const ledger = join(dataDir, 'review-answers.jsonl');
      const recorded = () =>
        (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n') : [])
          .filter((l) => l.includes(threadId))
          .map((l) => JSON.parse(l) as { answeredAt: number });
      await waitFor(() => recorded().some((r) => r.answeredAt >= closeStart), {
        describe: 'the answer-time record of the close',
      });
      expect(recorded()).toHaveLength(1);
    } finally {
      await lead.stop();
      await doc.stop();
    }
  });

  it('a body carrying partial answers cannot plant them on a new item', async () => {
    boot();
    const ws = await board();
    const file = join(dataDir, 'plant.md');
    writeFileSync(file, '# Plant\n\nText.\n');
    const { docId } = await jj<{ docId: string }>(
      post(`/workspaces/${ws}/docs`, { docId: 'plant', type: 'markdown', sourceUrl: file }),
    );
    const { thread } = await jj<{ thread: StoredThread }>(
      post(`/workspaces/${ws}/docs/${docId}/threads`, {
        author: FILER,
        text: 'Three things.',
        anchor: { kind: 'subject' },
        review: {
          ...THREE_QUESTIONS,
          partialAnswers: [{ text: 'planted', by: 'Reader', ts: 1, open: ['anything'] }],
        },
      }),
    );
    expect(thread.comments[0]?.review?.partialAnswers).toBeUndefined();
  });
});

describe('a spoken answer that covers some of an item’s questions', () => {
  it('on a ticket item: the item stays open and the ack says what is left', async () => {
    boot();
    const ws = await board();
    const { task } = await jj<{ task: { id: string } }>(
      post(`/workspaces/${ws}/tasks`, {
        title: 'Ship the nightly export',
        assignee: FILER.name,
        assigneeKind: 'agent',
        author: FILER,
      }),
    );
    const { item } = await jj<{ item: { id: string } }>(
      post(`/workspaces/${ws}/tasks/${task.id}/review-items`, {
        review: THREE_QUESTIONS,
        author: FILER,
      }),
    );
    classification = JSON.stringify({ kind: 'action', action: 'answer-review', id: task.id });
    verdict = { open: ['Who gets the failure alert?'] };
    const said = 'run it at 04:00 and include archived rows';
    const body = await jj<{ route: string; ack: string }>(
      post(`/workspaces/${ws}/voice`, {
        transcript: said,
        context: { surface: 'task', taskId: task.id, reviewItemId: item.id },
        author: PERSON,
      }),
    );
    expect(body.route).toBe('fast-path-action');
    expect(body.ack).toContain('Still open: "Who gets the failure alert?"');
    const stored = handle?.tasks.listReviewItems(task.id).find((r) => r.id === item.id);
    expect(stored?.answer).toBeUndefined();
    expect(stored?.partialAnswers?.map((p) => p.text)).toEqual([said]);
  });

  it('on an item declared on a comment: the item stays open and the ack says what is left', async () => {
    boot();
    const ws = await board();
    const { docId, threadId } = await declareOnDoc(ws);
    classification = JSON.stringify({ kind: 'action', action: 'answer-review', id: docId });
    verdict = { open: OPEN };
    const said = 'run it at 04:00';
    // Said twice at once, as a double-tap or a racing retry: one answer is
    // recorded, and both replies say what is still open.
    const speak = () =>
      jj<{ route: string; ack: string }>(
        post(`/workspaces/${ws}/voice`, {
          transcript: said,
          context: { surface: 'doc', docId },
          author: PERSON,
        }),
      );
    // The check is held until both requests are in, so the second arrives
    // while the first is still writing.
    let release = () => {};
    gate = new Promise((r) => {
      release = r;
    });
    const pending = Promise.all([speak(), speak()]);
    await waitFor(() => classified >= 2, { describe: 'both utterances classified' });
    await new Promise((r) => setTimeout(r, 0));
    release();
    const bodies = await pending;
    for (const body of bodies) {
      expect(body.route).toBe('fast-path-action');
      expect(body.ack).toContain('Still open: "Should archived rows be included?"');
    }
    expect(calls).toHaveLength(1);
    const payload = await declaration(ws, docId, threadId);
    expect(payload?.answeredAt).toBeUndefined();
    expect(payload?.partialAnswers?.map((p) => p.text)).toEqual([said]);
  });
});
