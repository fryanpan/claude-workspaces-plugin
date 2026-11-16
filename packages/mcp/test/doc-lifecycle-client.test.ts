/**
 * The tools that make, read, rewrite, archive and delete a doc, and
 * `attach_app`, call the server through the typed client over the lifecycle
 * contract (`packages/server/src/routes/doc-lifecycle-contract.ts`).
 *
 * The cases record what reached `http`: the same method, path, query and
 * body the hand-spelled paths sent, ids percent-encoded as before, and no key
 * for a field the caller left out. `typeProbes` and `answerProbes` never run;
 * `bun run typecheck` compiles them, and each `@ts-expect-error` fails the
 * typecheck if the line under it stops being an error.
 */
import { describe, expect, it } from 'vitest';
import { docLifecycleClient } from '../src/server-client.ts';
import { handleDocsTool } from '../src/tools/docs.ts';

const AUTHOR = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
const B = '/workspaces/w-1';
const D = `${B}/docs/berth%20plan`;

function recorder(answer: unknown = { ok: true }) {
  const calls: Array<[string, string, unknown]> = [];
  const watched: string[] = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return answer;
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
    watchDoc: async (docId: string) => {
      watched.push(docId);
      return true;
    },
    AUTHOR,
    CWD: '/tmp/harborlight-site',
  };
  const run = (tool: string, args: Record<string, unknown>) =>
    handleDocsTool(tool, { workspaceId: 'w-1', docId: 'berth plan', ...args }, ctx as never);
  return { calls, watched, run };
}

describe('the doc lifecycle tools, through the typed client', () => {
  it('lists docs with only the filters given, and always a limit', async () => {
    const r = recorder();
    await r.run('list_docs', {});
    await r.run('list_docs', {
      kind: 'mockup',
      query: 'quay',
      limit: 900,
      cursor: 'c-2',
      full: true,
    });
    expect(r.calls).toEqual([
      ['GET', `${B}/docs?limit=50`, undefined],
      ['GET', `${B}/docs?kind=mockup&query=quay&limit=500&cursor=c-2&full=1`, undefined],
    ]);
  });

  it('reads a doc as this reader, and its status', async () => {
    const r = recorder();
    await r.run('get_doc', {});
    await r.run('doc_status', {});
    expect(r.calls).toEqual([
      ['GET', `${D}/content?reader=agent-harborlight`, undefined],
      ['GET', `${D}/status`, undefined],
    ]);
  });

  it('attaches markdown and a mockup, and watches the id the server gave', async () => {
    const r = recorder({ docId: 'd-made' });
    await r.run('attach_markdown', { path: '/tmp/riverbend.md', title: 'Riverbend' });
    await r.run('attach_mockup', { sourceHtmlPath: '/tmp/saltmarsh.html' });
    expect(r.calls).toEqual([
      [
        'POST',
        `${B}/docs`,
        {
          docId: 'berth plan',
          type: 'markdown',
          sourceUrl: '/tmp/riverbend.md',
          owner: '/tmp/harborlight-site',
          title: 'Riverbend',
        },
      ],
      [
        'POST',
        `${B}/docs`,
        {
          docId: 'berth plan',
          type: 'mockup',
          owner: '/tmp/harborlight-site',
          sourceUrl: '/tmp/saltmarsh.html',
        },
      ],
    ]);
    expect(r.watched).toEqual(['d-made', 'd-made']);
  });

  it('attaches an app with its producer and the prefix mode when given', async () => {
    const r = recorder();
    await r.run('attach_app', { origin: 'http://127.0.0.1:5173', servesPrefix: false });
    expect(r.calls).toEqual([
      [
        'POST',
        `${B}/apps`,
        {
          docId: 'berth plan',
          origin: 'http://127.0.0.1:5173',
          owner: '/tmp/harborlight-site',
          producedBy: { agentId: 'agent-harborlight' },
          servesPrefix: false,
        },
      ],
    ]);
  });

  it('rewrites, reparses, archives, unarchives and deletes', async () => {
    const r = recorder();
    await r.run('set_doc_content', { markdown: '# Bob' });
    await r.run('set_doc_content', { markdown: '# Alice', confirmOverwriteHumanEdits: true });
    await r.run('reparse_from_disk', {});
    await r.run('archive_doc', { reason: 'superseded' });
    await r.run('unarchive_doc', {});
    await r.run('delete_doc', {});
    await r.run('delete_doc', { force: true });
    expect(r.calls).toEqual([
      ['POST', `${D}/content`, { markdown: '# Bob', author: AUTHOR }],
      [
        'POST',
        `${D}/content`,
        { markdown: '# Alice', author: AUTHOR, confirmOverwriteHumanEdits: true },
      ],
      ['POST', `${D}/reparse_from_disk`, undefined],
      ['POST', `${D}/archive`, { author: AUTHOR, reason: 'superseded' }],
      ['POST', `${D}/unarchive`, { author: AUTHOR }],
      ['DELETE', D, undefined],
      ['DELETE', `${D}?force=true`, undefined],
    ]);
  });
});

/** Compiled by `bun run typecheck`, never called. See the header. */
function typeProbes(client: ReturnType<typeof docLifecycleClient>): void {
  const board = client.workspaces[':ws'];
  const param = { ws: 'w', docId: 'd' };
  // @ts-expect-error — a rewrite reads `markdown`, not `content`.
  void board.docs[':docId'].content.$post({ param, json: { content: '# x' } });
  // @ts-expect-error — an app is attached by its `origin`.
  void board.apps.$post({ param: { ws: 'w' }, json: { docId: 'd' } });
  // @ts-expect-error — `force` is the word `true` or nothing.
  void board.docs[':docId'].$delete({ param, query: { force: 'yes' } });
  // The control: the same calls, spelled as the contract declares them, compile.
  void board.docs[':docId'].content.$post({ param, json: { markdown: '# x' } });
  void board.apps.$post({ param: { ws: 'w' }, json: { docId: 'd', origin: 'http://127.0.0.1:1' } });
  void board.docs[':docId'].$delete({ param, query: { force: 'true' } });
}

/** The answer the attach tools read is typed too. Compiled, never called. */
async function answerProbes(client: ReturnType<typeof docLifecycleClient>): Promise<void> {
  const made = await (
    await client.workspaces[':ws'].docs.$post({ param: { ws: 'w' }, json: { docId: 'd' } })
  ).json();
  // @ts-expect-error — the id the server gave is `docId`, not `id`.
  void made.id;
  // The control: the fields a tool reads are there, with their types.
  const docId: string = made.docId;
  const url: string | undefined = made.url;
  void [docId, url];
}
void typeProbes;
void answerProbes;
