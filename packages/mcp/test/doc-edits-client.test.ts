/**
 * The doc edit and anchor tools, and `create_thread`, call the server through
 * the typed client over the edit contract
 * (`packages/server/src/routes/doc-edits-contract.ts`) and the thread
 * contract.
 *
 * The cases record what reached `http`: the same method, path and body the
 * hand-spelled paths sent, ids percent-encoded as before, and no key for a
 * field the caller left out. `typeProbes` and `answerProbes` never run;
 * `bun run typecheck` compiles them, and each `@ts-expect-error` fails the
 * typecheck if the line under it stops being an error.
 */
import { describe, expect, it } from 'vitest';
import { docEditsClient, docThreadsClient } from '../src/server-client.ts';
import { handleDocsTool } from '../src/tools/docs.ts';

const AUTHOR = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
const SIGNED = { id: 'agent-harborlight', name: 'Harborlight site', color: '#336699' };
const D = '/workspaces/w-1/docs/berth%20plan';

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
    suggestionAuthor: () => SIGNED,
    CWD: '/tmp/harborlight-site',
  };
  const run = (tool: string, args: Record<string, unknown>) =>
    handleDocsTool(tool, { workspaceId: 'w-1', docId: 'berth plan', ...args }, ctx as never);
  return { calls, run };
}

describe('create_thread, through the typed client', () => {
  it('opens a subject thread, and one on found text', async () => {
    const r = recorder();
    await r.run('create_thread', { text: 'Why Riverbend?' });
    await r.run('create_thread', { text: 'This one.', find: 'the quay', occurrence: 2 });
    expect(r.calls).toEqual([
      [
        'POST',
        `${D}/threads`,
        { author: AUTHOR, text: 'Why Riverbend?', anchor: { kind: 'subject' } },
      ],
      [
        'POST',
        `${D}/threads/by_find`,
        { author: AUTHOR, text: 'This one.', find: 'the quay', occurrence: 2 },
      ],
    ]);
  });
});

describe('the doc edit tools, through the typed client', () => {
  it('sends find_and_replace with only the fields given, and signs a suggestion', async () => {
    const r = recorder();
    await r.run('find_and_replace', { find: 'quay', replace: 'Saltmarsh quay' });
    await r.run('find_and_replace', {
      find: 'quay',
      replace: 'pier',
      contextBefore: 'the ',
      replaceAll: true,
      parseInlineMarks: false,
      suggest: true,
      confirmOverwriteHumanEdits: true,
    });
    expect(r.calls).toEqual([
      [
        'POST',
        `${D}/find_and_replace`,
        { author: AUTHOR, find: 'quay', replace: 'Saltmarsh quay' },
      ],
      [
        'POST',
        `${D}/find_and_replace`,
        {
          author: SIGNED,
          confirmOverwriteHumanEdits: true,
          find: 'quay',
          replace: 'pier',
          contextBefore: 'the ',
          replaceAll: true,
          parseInlineMarks: false,
          suggest: true,
        },
      ],
    ]);
  });

  it('lists and resolves suggestions', async () => {
    const r = recorder();
    await r.run('list_suggestions', {});
    await r.run('accept_suggestion', { sid: 's/1' });
    await r.run('reject_suggestion', { sid: 's 2' });
    await r.run('resolve_all_suggestions', { action: 'accept' });
    await r.run('resolve_all_suggestions', { action: 'reject', authorId: 'agent-bob' });
    expect(r.calls).toEqual([
      ['GET', `${D}/suggestions`, undefined],
      ['POST', `${D}/suggestions/s%2F1/accept`, undefined],
      ['POST', `${D}/suggestions/s%202/reject`, undefined],
      ['POST', `${D}/suggestions/resolve_all`, { action: 'accept' }],
      ['POST', `${D}/suggestions/resolve_all`, { action: 'reject', authorId: 'agent-bob' }],
    ]);
  });

  it('creates, edits, fills and deletes an anchor', async () => {
    const r = recorder();
    await r.run('create_anchor', { find: 'Berths', label: 'berths' });
    await r.run('edit_at_anchor', { anchorId: 'a/1', op: { kind: 'replace', text: 'Moorings' } });
    await r.run('insert_blocks_at_anchor', { anchorId: 'a/1', markdown: '- Alice' });
    await r.run('delete_anchor', { anchorId: 'a/1' });
    const A = `${D}/agent_anchors/a%2F1`;
    expect(r.calls).toEqual([
      ['POST', `${D}/agent_anchors`, { find: 'Berths', label: 'berths' }],
      ['POST', `${A}/edit`, { author: AUTHOR, kind: 'replace', text: 'Moorings' }],
      ['POST', `${A}/insert_blocks`, { author: AUTHOR, markdown: '- Alice' }],
      ['DELETE', A, undefined],
    ]);
  });

  it('sends block edits signed, and the three structural deletes', async () => {
    const r = recorder();
    await r.run('apply_block_edits', { edits: [{ op: 'delete', blockId: 'b1' }] });
    await r.run('insert_blocks_under_heading', { headingId: 'h1', markdown: 'Bob' });
    await r.run('delete_block_at_anchor', { threadId: 't-1' });
    await r.run('delete_blocks_in_range', { startFind: 'From', endFind: 'To', endOccurrence: 2 });
    await r.run('delete_section', { heading: 'Old', level: 2 });
    expect(r.calls).toEqual([
      ['POST', `${D}/block_edits`, { edits: [{ op: 'delete', blockId: 'b1' }], author: SIGNED }],
      [
        'POST',
        `${D}/block_edits`,
        {
          edits: [{ op: 'insert_under_heading', headingId: 'h1', markdown: 'Bob' }],
          author: SIGNED,
        },
      ],
      ['POST', `${D}/delete_block_at_anchor`, { author: AUTHOR, threadId: 't-1' }],
      [
        'POST',
        `${D}/delete_blocks_in_range`,
        { author: AUTHOR, startFind: 'From', endFind: 'To', endOccurrence: 2 },
      ],
      ['POST', `${D}/delete_section`, { author: AUTHOR, heading: 'Old', level: 2 }],
    ]);
  });
});

/** Compiled by `bun run typecheck`, never called. See the header. */
function typeProbes(
  edits: ReturnType<typeof docEditsClient>,
  threads: ReturnType<typeof docThreadsClient>,
): void {
  const doc = edits.workspaces[':ws'].docs[':docId'];
  const param = { ws: 'w', docId: 'd' };
  // @ts-expect-error — find_and_replace reads `replace`, not `replacement`.
  void doc.find_and_replace.$post({ param, json: { find: 'a', replacement: 'b' } });
  // @ts-expect-error — `anchorId` is part of an anchor's address.
  void doc.agent_anchors[':anchorId'].$delete({ param });
  // @ts-expect-error — a subject thread names its anchor.
  void threads.workspaces[':ws'].docs[':docId'].threads.$post({ param, json: { text: 't' } });
  // The control: the same calls, spelled as the contracts declare them, compile.
  void doc.find_and_replace.$post({ param, json: { find: 'a', replace: 'b' } });
  void doc.agent_anchors[':anchorId'].$delete({ param: { ...param, anchorId: 'a' } });
  void threads.workspaces[':ws'].docs[':docId'].threads.$post({
    param,
    json: { text: 't', anchor: { kind: 'subject' } },
  });
}

/** The answers the tools read are typed too. Compiled, never called. */
async function answerProbes(
  edits: ReturnType<typeof docEditsClient>,
  threads: ReturnType<typeof docThreadsClient>,
): Promise<void> {
  const param = { ws: 'w', docId: 'd' };
  const anchor = await (
    await edits.workspaces[':ws'].docs[':docId'].agent_anchors.$post({ param, json: { find: 'x' } })
  ).json();
  // @ts-expect-error — a new anchor's id is `anchorId`, not `id`.
  void anchor.id;
  const created = await (
    await threads.workspaces[':ws'].docs[':docId'].threads.by_find.$post({
      param,
      json: { text: 't', find: 'x' },
    })
  ).json();
  // @ts-expect-error — the new thread is `thread`, not `created`.
  void created.created;
  // The control: the fields the tools read are there, with their types.
  const anchorId: string | undefined = anchor.anchorId;
  const threadId: string = created.thread.id;
  const url: string | undefined = created.url;
  void [anchorId, threadId, url];
}
void typeProbes;
void answerProbes;
