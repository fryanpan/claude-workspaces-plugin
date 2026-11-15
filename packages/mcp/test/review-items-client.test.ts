/**
 * The review-item tools call the server through the typed client, over the
 * review-items contract (`packages/server/src/routes/review-items-contract.ts`).
 *
 * The cases record what reached `http`: the same method, path and body the
 * hand-spelled paths sent, ids percent-encoded as before, and no key for a
 * field the caller left out. `typeProbes` never runs; `bun run typecheck`
 * compiles it, and each `@ts-expect-error` fails the typecheck if the line
 * under it stops being an error.
 */
import { describe, expect, it } from 'vitest';
import { reviewItemsClient } from '../src/server-client.ts';
import { handleTaskTool } from '../src/tools/tasks.ts';

const AUTHOR = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
const B = '/workspaces/w-1';
const T = `${B}/tasks/t%201`;

const TASK = {
  id: 't 1',
  title: 'Riverbend survey',
  status: 'todo',
  assignee: 'Alice',
  goal: 'g-1',
  order: 1,
  links: [{ kind: 'pr', url: 'https://example.invalid/1' }],
};

function recorder(answer: unknown) {
  const calls: Array<[string, string, unknown]> = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return answer;
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
    AUTHOR,
    claimNoticeFor: async () => undefined,
  };
  /** The tool's answer, parsed. */
  const run = async (tool: string, args: Record<string, unknown>) => {
    const out = (await handleTaskTool(tool, { workspaceId: 'w-1', ...args }, ctx as never)) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(out.content[0]?.text ?? 'null') as Record<string, unknown>;
  };
  return { calls, run };
}

/** Each recorded body's keys, in the order they were sent. */
const keysOf = (calls: Array<[string, string, unknown]>) =>
  calls.map(([, , body]) => (body === undefined ? [] : Object.keys(body as object)));

describe('the review-item tools, through the typed client', () => {
  it('files an item and forwards a hold', async () => {
    const r = recorder({
      task: TASK,
      item: { id: 'r-1' },
      url: '/workspaces/w-1/home',
      reviewAdvice: 'name the file',
      held: true,
      heldReason: 'vague',
      message: 'revise it',
    });
    const review = { shape: 'review', headline: 'Is the Saltmarsh timetable right?' };
    const out = await r.run('add_review_item', { taskId: 't 1', review });
    expect(r.calls).toEqual([['POST', `${T}/review-items`, { review, author: AUTHOR }]]);
    expect(out).toEqual({
      taskId: 't 1',
      reviewItemId: 'r-1',
      url: '/workspaces/w-1/home',
      reviewAdvice: 'name the file',
      held: true,
      heldReason: 'vague',
      message: 'revise it',
    });
  });

  it('answers an item, the ticket decision, and a bare item id', async () => {
    const r = recorder({ kind: 'task-item', taskId: 't 1', workspaceId: 'w-1', task: TASK });
    await r.run('answer_review_item', {
      taskId: 't 1',
      reviewItemId: 'r 1',
      text: 'Yes',
      answeredWith: 'o-1',
    });
    await r.run('answer_decision', { taskId: 't 1', text: 'Yes', optionId: 'o-1' });
    await r.run('answer_decision', { taskId: 't 1', text: 'Yes' });
    const out = await r.run('answer_review_item', { reviewItemId: 'r-2', text: 'No' });
    expect(r.calls).toEqual([
      [
        'POST',
        `${T}/review-items/r%201/answer`,
        { text: 'Yes', answeredWith: 'o-1', author: AUTHOR },
      ],
      ['POST', `${T}/answer`, { text: 'Yes', optionId: 'o-1', author: AUTHOR }],
      ['POST', `${T}/answer`, { text: 'Yes', author: AUTHOR }],
      ['GET', `${B}/review-items/r-2`, undefined],
      ['POST', `${T}/review-items/r-2/answer`, { text: 'No', author: AUTHOR }],
    ]);
    expect(keysOf(r.calls)[2]).toEqual(['text', 'author']);
    expect(out).toEqual({ taskId: 't 1', reviewItemId: 'r-2', recorded: true, links: TASK.links });
  });

  it('revises a ticket item, the ticket decision and a doc-thread item', async () => {
    const r = recorder({ task: TASK, item: { id: 'r-1' }, threadId: 'th-1', url: '/u' });
    const out = await r.run('revise_review_item', {
      taskId: 't 1',
      reviewItemId: 'r-1',
      headline: 'Is the Riverbend timetable right?',
      reply: 'Reworded.',
    });
    await r.run('revise_review_item', { taskId: 't 1', detail: 'Two options.' });
    await r.run('revise_review_item', {
      docId: 'd-1',
      threadId: 'th-1',
      commentId: 'c-1',
      lessSpecific: 'the source names no date',
    });
    expect(r.calls).toEqual([
      [
        'POST',
        `${T}/review-items/r-1/revise`,
        { headline: 'Is the Riverbend timetable right?', author: AUTHOR, reply: 'Reworded.' },
      ],
      ['POST', `${T}/review-items/r-legacy/revise`, { detail: 'Two options.', author: AUTHOR }],
      [
        'POST',
        `${B}/docs/d-1/threads/th-1/revise`,
        { lessSpecific: 'the source names no date', author: AUTHOR, commentId: 'c-1' },
      ],
    ]);
    expect(keysOf(r.calls)).toEqual([
      ['headline', 'author', 'reply'],
      ['detail', 'author'],
      ['lessSpecific', 'author', 'commentId'],
    ]);
    expect(out).toMatchObject({ revised: true, threadId: 'th-1', replied: true, url: '/u' });
  });

  it('withdraws an item and puts it back', async () => {
    const r = recorder({
      taskId: 't 1',
      reviewItemId: 'r-1',
      item: { id: 'r-1' },
      withdrawn: true,
    });
    await r.run('withdraw_review_item', { taskId: 't 1', reviewItemId: 'r-1', reason: 'moot' });
    const back = await r.run('withdraw_review_item', {
      taskId: 't 1',
      reviewItemId: 'r-1',
      undo: true,
    });
    expect(r.calls).toEqual([
      ['POST', `${T}/review-items/r-1/withdraw`, { author: AUTHOR, reason: 'moot' }],
      ['POST', `${T}/review-items/r-1/withdraw/undo`, { author: AUTHOR }],
    ]);
    expect(back).toEqual({ taskId: 't 1', reviewItemId: 'r-1', withdrawn: false });
  });

  it('asks back on the ticket decision and on an item', async () => {
    const r = recorder({ task: TASK });
    await r.run('request_more_info', { taskId: 't 1', question: 'Which week?' });
    const out = await r.run('request_more_info', {
      taskId: 't 1',
      reviewItemId: 'r-1',
      question: 'Which week?',
    });
    expect(r.calls).toEqual([
      ['POST', `${T}/more-info`, { question: 'Which week?', author: AUTHOR }],
      ['POST', `${T}/review-items/r-1/more-info`, { question: 'Which week?', author: AUTHOR }],
    ]);
    expect(out).toEqual({ taskId: 't 1', reviewItemId: 'r-1', asked: true, links: TASK.links });
  });
});

/** Compiled, never run: a renamed field fails the typecheck. */
async function typeProbes(http: never): Promise<void> {
  const ticket = reviewItemsClient(http).workspaces[':ws'].tasks[':taskId'];
  const param = { ws: 'w-1', taskId: 't-1' };
  const item = { ...param, itemId: 'r-1' };
  const onItem = ticket['review-items'][':itemId'];
  // @ts-expect-error -- an item's option is `answeredWith`; `optionId` is the ticket's spelling.
  await onItem.answer.$post({ param: item, json: { text: 'x', optionId: 'o' } });
  // @ts-expect-error -- the ticket decision's option is `optionId`.
  await ticket.answer.$post({ param, json: { text: 'x', answeredWith: 'o' } });
  // @ts-expect-error -- a revision's reply is `reply`.
  await onItem.revise.$post({ param: item, json: { replyText: 'x' } });
  // @ts-expect-error -- an ask-back's words are `question`.
  await ticket['more-info'].$post({ param, json: { text: 'x' } });
  const filed = await (await ticket['review-items'].$post({ param, json: { review: {} } })).json();
  // @ts-expect-error -- the filed item is `item`, with its `id`.
  void filed.reviewItemId;
  const where = await (
    await reviewItemsClient(http).workspaces[':ws']['review-items'][':itemId'].$get({
      param: { ws: 'w-1', itemId: 'r-1' },
    })
  ).json();
  // @ts-expect-error -- `taskId` is only on a ticket item; a doc-thread one has none.
  void where.taskId;
}
void typeProbes;
