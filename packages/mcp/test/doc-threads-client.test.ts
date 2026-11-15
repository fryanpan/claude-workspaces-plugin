/**
 * The doc thread tools call the server through the typed client over the
 * thread contract (`packages/server/src/routes/doc-threads-contract.ts`).
 *
 * The cases record what reached `http` for the tools no other test pins:
 * the same method, path and body the hand-spelled paths sent, with ids
 * percent-encoded as before. `typeProbes` (request bodies) and
 * `answerProbes` (answer fields) never run; `bun run typecheck` compiles
 * them, and each `@ts-expect-error` fails the typecheck if the line under it
 * stops being an error.
 */
import { describe, expect, it } from 'vitest';
import { docThreadsClient } from '../src/server-client.ts';
import { handleDocsTool } from '../src/tools/docs.ts';

const AUTHOR = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
const T = '/workspaces/w-1/docs/berth%20plan/threads/t%2F1';

function recorder() {
  const calls: Array<[string, string, unknown]> = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return { ok: true };
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
    AUTHOR,
    CWD: '/tmp/harborlight-site',
  };
  const run = (tool: string, args: Record<string, unknown>) =>
    handleDocsTool(
      tool,
      { workspaceId: 'w-1', docId: 'berth plan', threadId: 't/1', ...args },
      ctx as never,
    );
  return { calls, run };
}

describe('the doc thread tools, through the typed client', () => {
  it('reads a thread, and the list with and without a status', async () => {
    const r = recorder();
    await r.run('get_thread', {});
    await r.run('list_threads', {});
    await r.run('list_threads', { status: 'open' });
    expect(r.calls).toEqual([
      ['GET', T, undefined],
      ['GET', '/workspaces/w-1/docs/berth%20plan/threads', undefined],
      ['GET', '/workspaces/w-1/docs/berth%20plan/threads?status=open', undefined],
    ]);
  });

  it('posts a reply and an edit with their bodies', async () => {
    const r = recorder();
    await r.run('post_reply', { text: 'Moved to Riverbend.', to: ['Alice'] });
    await r.run('edit_comment', { commentId: 'c-1', text: 'Fixed.', reason: 'typo' });
    expect(r.calls).toEqual([
      ['POST', `${T}/comments`, { author: AUTHOR, text: 'Moved to Riverbend.', to: ['Alice'] }],
      [
        'POST',
        `${T}/edit-comment`,
        { author: AUTHOR, commentId: 'c-1', text: 'Fixed.', reason: 'typo' },
      ],
    ]);
  });

  it('resolves and reopens with no body; a summary sends force only when asked', async () => {
    const r = recorder();
    await r.run('resolve_thread', {});
    await r.run('reopen_thread', {});
    await r.run('summarize_thread', { force: true });
    await r.run('summarize_thread', {});
    expect(r.calls).toEqual([
      ['POST', `${T}/resolve`, undefined],
      ['POST', `${T}/reopen`, undefined],
      ['POST', `${T}/summary`, { force: true }],
      // An empty body, where the hand-spelled call sent none; the route reads
      // only `force === true`, so both mean "no force".
      ['POST', `${T}/summary`, {}],
    ]);
  });

  it('sends the three thread edits with the scoped-edit fields', async () => {
    const r = recorder();
    await r.run('rewrite_thread_region', { replacement: 'Saltmarsh', parseInlineMarks: false });
    await r.run('insert_after_thread', { text: 'Bob agreed.', confirmOverwriteHumanEdits: true });
    await r.run('insert_blocks_after_thread', { markdown: '## Next', placement: 'top-level' });
    expect(r.calls).toEqual([
      [
        'POST',
        `${T}/rewrite_region`,
        { author: AUTHOR, replacement: 'Saltmarsh', parseInlineMarks: false },
      ],
      [
        'POST',
        `${T}/insert_after`,
        { author: AUTHOR, confirmOverwriteHumanEdits: true, text: 'Bob agreed.' },
      ],
      [
        'POST',
        `${T}/insert_blocks_after`,
        { author: AUTHOR, markdown: '## Next', placement: 'top-level' },
      ],
    ]);
  });
});

/** Compiled by `bun run typecheck`, never called. See the header. */
function typeProbes(client: ReturnType<typeof docThreadsClient>): void {
  const thread = client.workspaces[':ws'].docs[':docId'].threads[':threadId'];
  const param = { ws: 'w', docId: 'd', threadId: 't' };
  // @ts-expect-error — the comments route reads `text`, not `body`.
  void thread.comments.$post({ param, json: { body: 'hi' } });
  // @ts-expect-error — `commentId` is required to withdraw an item.
  void thread.withdraw.$post({ param, json: { reason: 'stale' } });
  // @ts-expect-error — progress takes three states, and `finished` is none of them.
  void thread.progress.$post({ param, json: { state: 'finished' } });
  // @ts-expect-error — there is no `/threads/:threadId/close`.
  void thread.close.$post({ param });
  // @ts-expect-error — `threadId` is part of the address.
  void thread.resolve.$post({ param: { ws: 'w', docId: 'd' } });
  // The control: the same calls, spelled as the contract declares them, compile.
  void thread.comments.$post({ param, json: { text: 'hi' } });
  void thread.withdraw.$post({ param, json: { commentId: 'c-1' } });
  void thread.resolve.$post({ param });
}

/** The answers the tools read are typed too. Compiled, never called. */
async function answerProbes(client: ReturnType<typeof docThreadsClient>): Promise<void> {
  const thread = client.workspaces[':ws'].docs[':docId'].threads[':threadId'];
  const param = { ws: 'w', docId: 'd', threadId: 't' };
  const revised = await (await thread.revise.$post({ param, json: { commentId: 'c' } })).json();
  // @ts-expect-error — the revise answer's link is `url`, not `link`.
  void revised.link;
  const promoted = await (await thread.promote.$post({ param, json: {} })).json();
  // @ts-expect-error — a promoted task's words are `title`, not `name`.
  void promoted.task.name;
  // The control: the fields the tools read are there, with their types.
  const url: string | undefined = revised.url;
  const heldReason: string | undefined = revised.heldReason;
  const title: string = promoted.task.title;
  void [url, heldReason, title];
}
void typeProbes;
void answerProbes;
