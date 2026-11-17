/**
 * The sharing tools and `post_status` call the server through the typed
 * client, over the share contract (`packages/server/src/routes/share-contract.ts`)
 * and the agent-notes contract (`agent-notes-contract.ts`).
 *
 * The cases record what reached `http`: the same method, path and body the
 * hand-spelled paths sent, ids percent-encoded as before, and no key for a
 * field the caller left out. `typeProbes` and `answerProbes` never run;
 * `bun run typecheck` compiles them, and each `@ts-expect-error` fails the
 * typecheck if the line under it stops being an error.
 */
import { describe, expect, it } from 'vitest';
import { agentNotesClient, shareClient } from '../src/server-client.ts';
import { handleDocsTool } from '../src/tools/docs.ts';

const AUTHOR = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
const B = '/workspaces/w-1';

function recorder(answer: unknown = { ok: true }) {
  const calls: Array<[string, string, unknown]> = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return answer;
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
    watchWorkspace: async () => {},
    AUTHOR,
    CWD: '/tmp/harborlight-site',
  };
  const run = (tool: string, args: Record<string, unknown>) =>
    handleDocsTool(tool, { workspaceId: 'w-1', ...args }, ctx as never);
  /** The answer's text, parsed. */
  const answered = async (tool: string, args: Record<string, unknown>) => {
    const out = (await run(tool, args)) as { content: Array<{ text: string }> };
    return JSON.parse(out.content[0]?.text ?? 'null') as Record<string, unknown>;
  };
  return { calls, run, answered };
}

describe('the sharing tools, through the typed client', () => {
  it('shares a board, forwarding every argument as sent', async () => {
    const r = recorder();
    await r.run('share_workspace', { allowDomains: ['example.invalid'], label: 'Riverbend' });
    expect(r.calls).toEqual([
      [
        'POST',
        '/api/share/workspace',
        {
          workspaceId: 'w-1',
          allowDomains: ['example.invalid'],
          label: 'Riverbend',
          createdBy: 'Harborlight site',
        },
      ],
    ]);
  });

  it('removes a member, and sets a member’s role and the board’s audience', async () => {
    const r = recorder();
    await r.run('remove_share_member', { email: 'alice@example.invalid' });
    await r.run('set_share_member_role', { email: 'bob@example.invalid', role: 'view' });
    await r.run('set_share_member_role', {
      email: 'bob@example.invalid',
      role: 'edit',
      taskId: 't-1',
      why: 'reviews the plan',
    });
    await r.run('set_share_audience', { add: ['alice@example.invalid'] });
    await r.run('set_share_audience', { remove: ['bob@example.invalid'], taskId: 't-1', why: 'w' });
    expect(r.calls).toEqual([
      ['POST', '/api/share/member/remove', { workspaceId: 'w-1', email: 'alice@example.invalid' }],
      ['POST', `${B}/members/bob%40example.invalid/role`, { role: 'view', author: AUTHOR }],
      [
        'POST',
        `${B}/members/bob%40example.invalid/role`,
        { role: 'edit', taskId: 't-1', why: 'reviews the plan', author: AUTHOR },
      ],
      ['POST', `${B}/audience`, { add: ['alice@example.invalid'], author: AUTHOR }],
      [
        'POST',
        `${B}/audience`,
        { remove: ['bob@example.invalid'], taskId: 't-1', why: 'w', author: AUTHOR },
      ],
    ]);
  });

  it('lists, extends and ends shares', async () => {
    const r = recorder();
    await r.run('list_shares', {});
    await r.run('set_share_ttl', { shareId: 'share/1', ttlSeconds: 3600 });
    await r.run('unshare', { shareId: 'share/1' });
    expect(r.calls).toEqual([
      ['GET', '/api/share', undefined],
      ['POST', '/api/share/share%2F1/ttl', { ttlSeconds: 3600 }],
      ['DELETE', '/api/share/share%2F1', undefined],
    ]);
  });

  it('turns sharing off for a board, and reads whether it is on', async () => {
    const r = recorder({ sharing: { enabled: true, locked: false, closedBoards: ['w-1'] } });
    await r.run('set_sharing_enabled', { enabled: false, reason: 'paused' });
    const read = await r.answered('set_sharing_enabled', {});
    expect(r.calls).toEqual([
      [
        'POST',
        '/api/share/enabled',
        {
          enabled: false,
          workspaceId: 'w-1',
          reason: 'paused',
          actor: { id: AUTHOR.id, name: AUTHOR.name },
        },
      ],
      ['GET', '/api/share', undefined],
    ]);
    expect(read.board).toEqual({ workspaceId: 'w-1', enabled: false });
  });

  it('locks a board, and reads whether it is locked', async () => {
    const r = recorder({ sharing: { enabled: true, locked: false, lockedBoards: ['w-1'] } });
    await r.run('set_board_sharing_lock', { locked: true, taskId: 't-1', why: 'private' });
    const read = await r.answered('set_board_sharing_lock', {});
    expect(r.calls).toEqual([
      [
        'POST',
        '/api/share/lock',
        {
          workspaceId: 'w-1',
          locked: true,
          taskId: 't-1',
          why: 'private',
          actor: { id: AUTHOR.id, name: AUTHOR.name },
        },
      ],
      ['GET', '/api/share', undefined],
    ]);
    expect(read).toEqual({ workspaceId: 'w-1', board: { workspaceId: 'w-1', locked: true } });
  });
});

describe('post_status, through the typed client', () => {
  it('notes a named task, or the agent’s own row on the board', async () => {
    const r = recorder({ ok: true, workspaceId: 'w-1', taskId: 't-made' });
    const onTask = await r.answered('post_status', { text: ' Halfway. ', taskId: 't 1' });
    const onRow = await r.answered('post_status', { text: 'Done.' });
    const [first, second] = r.calls;
    expect([first?.[0], first?.[1]]).toEqual(['POST', `${B}/tasks/t%201/notes`]);
    expect([second?.[0], second?.[1]]).toEqual(['POST', `${B}/agents/Harborlight%20site/notes`]);
    expect(first?.[2]).toMatchObject({
      agent: 'Harborlight site',
      kind: 'status',
      text: 'Halfway.',
    });
    expect(typeof (first?.[2] as { at: unknown }).at).toBe('number');
    expect(onTask).toEqual({ posted: true, taskId: 't-made', workspaceId: 'w-1' });
    expect(onRow).toEqual(onTask);
  });

  it('says so when no row took the note', async () => {
    const r = recorder({ ok: true, workspaceId: 'w-1' });
    const out = await r.answered('post_status', { text: 'Waiting.' });
    expect(out).toMatchObject({ posted: true, workspaceId: 'w-1' });
    expect(out.note).toContain('no in-progress task');
  });
});

/** Compiled by `bun run typecheck`, never called. See the header. */
function typeProbes(
  share: ReturnType<typeof shareClient>,
  notes: ReturnType<typeof agentNotesClient>,
): void {
  // @ts-expect-error — removing a member names the board as `workspaceId`.
  void share.api.share.member.remove.$post({ json: { boardId: 'w', email: 'e' } });
  // @ts-expect-error — the master switch reads `enabled`, not `on`.
  void share.api.share.enabled.$post({ json: { on: true } });
  const row = notes.workspaces[':ws'].tasks[':taskId'].notes;
  void row.$post({
    param: { ws: 'w', taskId: 't' },
    // @ts-expect-error — a note's words are `text`, not `body`.
    json: { agent: 'a', kind: 'status', body: 'x' },
  });
  // The control: the same calls, spelled as the contracts declare them, compile.
  void share.api.share.member.remove.$post({ json: { workspaceId: 'w', email: 'e' } });
  void share.api.share.enabled.$post({ json: { enabled: true } });
  void row.$post({
    param: { ws: 'w', taskId: 't' },
    json: { agent: 'a', kind: 'status', text: 'x' },
  });
}

/** The answers the tools read a field of are typed too. Compiled, never called. */
async function answerProbes(
  share: ReturnType<typeof shareClient>,
  notes: ReturnType<typeof agentNotesClient>,
): Promise<void> {
  const listed = await (await share.api.share.$get()).json();
  // @ts-expect-error — the closed boards are under `sharing`.
  void listed.closedBoards;
  const noted = await (
    await notes.workspaces[':ws'].agents[':agent'].notes.$post({
      param: { ws: 'w', agent: 'a' },
      json: { agent: 'a', kind: 'status', text: 'x' },
    })
  ).json();
  // @ts-expect-error — the row a note landed on is `taskId`.
  void noted.task;
  // The control: the fields a tool reads are there, with their types.
  const closed: string[] | undefined = listed.sharing.closedBoards;
  const taskId: string | undefined = noted.taskId;
  void [closed, taskId];
}
void typeProbes;
void answerProbes;
