/**
 * The attachment-set tools, the folder bind and `delete_workspace` call the
 * server through the typed client over the attachments contract
 * (`packages/server/src/routes/attachments-contract.ts`).
 *
 * The cases record what reached `http`: the same method, path, query and
 * body the hand-spelled paths sent, ids percent-encoded as before, and no key
 * for a field the caller left out. `typeProbes` and `answerProbes` never run;
 * `bun run typecheck` compiles them, and each `@ts-expect-error` fails the
 * typecheck if the line under it stops being an error.
 */
import { describe, expect, it } from 'vitest';
import { attachmentsClient } from '../src/server-client.ts';
import { handleDocsTool } from '../src/tools/docs.ts';

const AUTHOR = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
const B = '/workspaces/w-1';
const S = `${B}/attachments/set%2F1`;

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
    watchWorkspace: async (id: string) => {
      watched.push(id);
    },
    AUTHOR,
    CWD: '/tmp/harborlight-site',
  };
  const run = (tool: string, args: Record<string, unknown>) =>
    handleDocsTool(tool, { workspaceId: 'w-1', ...args }, ctx as never);
  return { calls, watched, run };
}

describe('the attachment tools, through the typed client', () => {
  it('binds a folder on the board, and watches the set it made', async () => {
    const r = recorder({ ok: true, workspaceId: 'set-made' });
    await r.run('attach_folder', { folderPath: '/tmp/riverbend', privacy: 'local' });
    await r.run('attach_folder', {
      folderPath: '/tmp/riverbend',
      setId: 'set-1',
      include: ['*.md'],
      maxFiles: 20,
      subscribe: false,
    });
    expect(r.calls).toEqual([
      [
        'POST',
        '/workspaces',
        {
          folderPath: '/tmp/riverbend',
          owner: '/tmp/harborlight-site',
          hubWorkspaceId: 'w-1',
          privacy: 'local',
        },
      ],
      [
        'POST',
        '/workspaces',
        {
          folderPath: '/tmp/riverbend',
          owner: '/tmp/harborlight-site',
          workspaceId: 'set-1',
          hubWorkspaceId: 'w-1',
          include: ['*.md'],
          maxFiles: 20,
        },
      ],
    ]);
    expect(r.watched).toEqual(['set-made']);
  });

  it('opens a diff review, and watches the review it made', async () => {
    const r = recorder({ ok: true, reviewId: 'rev-made' });
    await r.run('create_diff_review', {
      repo: '/tmp/saltmarsh',
      base: 'main',
      groups: [{ title: 'Core', paths: ['src'] }],
    });
    expect(r.calls).toEqual([
      [
        'POST',
        `${B}/attachments`,
        {
          repo: '/tmp/saltmarsh',
          base: 'main',
          owner: '/tmp/harborlight-site',
          groups: [{ title: 'Core', paths: ['src'] }],
        },
      ],
    ]);
    expect(r.watched).toEqual(['rev-made']);
  });

  it('archives, unarchives, lists, refreshes, regroups and deletes a set', async () => {
    const r = recorder();
    await r.run('archive_attachment_set', { setId: 'set/1', reason: 'merged' });
    await r.run('unarchive_attachment_set', { setId: 'set/1' });
    await r.run('list_archived_attachments', {});
    await r.run('refresh_attachment_set', { setId: 'set/1' });
    await r.run('set_attachment_groups', { setId: 'set/1', groups: [] });
    await r.run('delete_attachment_set', { setId: 'set/1' });
    await r.run('delete_attachment_set', { setId: 'set/1', force: true, purge: true });
    expect(r.calls).toEqual([
      ['POST', `${S}/archive`, { author: AUTHOR, reason: 'merged' }],
      ['POST', `${S}/unarchive`, { author: AUTHOR }],
      ['GET', `${B}/attachments?archived=true`, undefined],
      ['POST', `${S}/refresh`, {}],
      ['POST', `${S}/groups`, { groups: [] }],
      ['DELETE', S, undefined],
      ['DELETE', `${S}?force=true&purge=true`, undefined],
    ]);
  });

  it('deletes a board by its own id', async () => {
    const r = recorder();
    await r.run('delete_workspace', { workspaceId: 'w 2' });
    await r.run('delete_workspace', { workspaceId: 'w 2', force: true });
    expect(r.calls).toEqual([
      ['DELETE', '/workspaces/w%202', undefined],
      ['DELETE', '/workspaces/w%202?force=true', undefined],
    ]);
  });
});

/** Compiled by `bun run typecheck`, never called. See the header. */
function typeProbes(client: ReturnType<typeof attachmentsClient>): void {
  const set = client.workspaces[':ws'].attachments[':setId'];
  const param = { ws: 'w', setId: 's' };
  // @ts-expect-error — a diff review reads `repo`, not `repoPath`.
  void client.workspaces[':ws'].attachments.$post({ param: { ws: 'w' }, json: { repoPath: '/r' } });
  // @ts-expect-error — regrouping needs `groups`.
  void set.groups.$post({ param, json: {} });
  // @ts-expect-error — `setId` is part of a set's address.
  void set.archive.$post({ param: { ws: 'w' }, json: {} });
  // The control: the same calls, spelled as the contract declares them, compile.
  void client.workspaces[':ws'].attachments.$post({ param: { ws: 'w' }, json: { repo: '/r' } });
  void set.groups.$post({ param, json: { groups: [] } });
  void set.archive.$post({ param, json: {} });
}

/** The answers the bind tools read are typed too. Compiled, never called. */
async function answerProbes(client: ReturnType<typeof attachmentsClient>): Promise<void> {
  const review = await (
    await client.workspaces[':ws'].attachments.$post({ param: { ws: 'w' }, json: { repo: '/r' } })
  ).json();
  // @ts-expect-error — a review's id is `reviewId`, not `id`.
  void review.id;
  const bound = await (await client.workspaces.$post({ json: { folderPath: '/f' } })).json();
  // @ts-expect-error — a folder bind's answer may be a board's, so narrow it first.
  void bound.workspaceId;
  // The control: the fields a tool reads are there, with their types.
  const reviewId: string = review.reviewId;
  const setId: string | undefined = 'workspaceId' in bound ? bound.workspaceId : undefined;
  void [reviewId, setId];
}
void typeProbes;
void answerProbes;
