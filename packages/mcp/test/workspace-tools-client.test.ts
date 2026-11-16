/**
 * Every tool in `tools/workspace.ts` calls the server through the typed
 * client, over the board, agents, dispatches, doc file, person, lead meeting
 * and agent machine contracts.
 *
 * The cases record what reached `http`: the same method, path and body the
 * hand-spelled paths sent, ids percent-encoded as before, and no key for a
 * field the caller left out. `typeProbes` never runs; `bun run typecheck`
 * compiles it, and each `@ts-expect-error` fails the typecheck if the line
 * under it stops being an error.
 */
import { describe, expect, it } from 'vitest';
import {
  agentMachineClient,
  dispatchesClient,
  docFileClient,
  workspaceAgentsClient,
  workspaceBoardClient,
} from '../src/server-client.ts';
import { handleWorkspaceTool } from '../src/tools/workspace.ts';

const AUTHOR = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
const B = '/workspaces/w%201';

type Call = [string, string, unknown];

/** One answer that every tool in this file can read without throwing. */
const ANSWER = {
  changed: true,
  workspace: { id: 'w 1', name: 'Riverbend', docIds: ['d-1'], leadAgentId: 'agent-harborlight' },
  url: '/workspaces/w%201',
  reviewItemCriteria: { value: 'Name the decision.', isDefault: false, default: 'x' },
  goalSummary: [],
  considered: 0,
  matches: [],
  attachment: { agentId: 'agent-harborlight' },
  queuedComments: [{ id: 'q 1', docId: 'd-1', event: 'comment', text: 'Alice asks', ts: 1 }],
  delivered: true,
  cap: 2,
  isDefault: false,
  default: 3,
  inUse: 0,
  free: 2,
  holders: [],
};

/** `refuse`, when given, is the error every call throws, as `http` throws a non-2xx. */
function recorder(refuse?: string) {
  const calls: Call[] = [];
  const marks: string[] = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      if (refuse !== undefined) throw new Error(refuse);
      return ANSWER;
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
    AUTHOR,
    PLUGIN_VERSION: '9.9.9',
    PROCESS_ID: 'p-1',
    IDENTITY_IS_SHARED: false,
    markAttached: (ws: string) => marks.push(`attached ${ws}`),
    markDetached: (ws: string) => marks.push(`detached ${ws}`),
    unwatchDoc: async (id: string) => {
      marks.push(`unwatch ${id}`);
    },
    watchWorkspace: async (ws: string) => {
      marks.push(`watch ${ws}`);
      return true;
    },
  };
  /** The tool's answer, parsed. */
  const run = async (name: string, args: Record<string, unknown>) => {
    const out = await handleWorkspaceTool(name, { workspaceId: 'w 1', ...args }, ctx as never);
    return JSON.parse(
      String(out?.content[0]?.type === 'text' ? (out.content[0] as { text: string }).text : 'null'),
    ) as Record<string, unknown>;
  };
  return { calls, marks, run };
}

describe('the board tools, through the typed client', () => {
  it('sends each verb where the hand-spelled path did', async () => {
    const r = recorder();
    await r.run('rename_workspace', { name: 'Saltmarsh' });
    await r.run('archive_workspace', { reason: 'merged into Riverbend' });
    await r.run('unretire_workspace', { reason: 'ignored when un-archiving' });
    await r.run('set_review_item_criteria', { criteria: '  ' });
    await r.run('set_review_item_criteria', { criteria: 'Name the decision.' });
    await r.run('attach_doc', { docId: 'd 1' });
    await r.run('get_workspace', {});
    await r.run('find_related_work', { text: 'a plan', docId: 'd 1', limit: 3 });
    await r.run('find_related_work', { text: 'a plan', docId: '' });
    await r.run('set_parallelism_cap', { cap: 2 });
    expect(r.calls).toEqual([
      ['POST', `${B}/rename`, { name: 'Saltmarsh', author: AUTHOR }],
      ['PUT', `${B}/retired`, { retired: true, reason: 'merged into Riverbend', author: AUTHOR }],
      ['PUT', `${B}/retired`, { retired: false, author: AUTHOR }],
      ['PUT', `${B}/settings`, { reviewItemCriteria: null, author: AUTHOR }],
      ['PUT', `${B}/settings`, { reviewItemCriteria: 'Name the decision.', author: AUTHOR }],
      ['POST', `${B}/docs:attach`, { docId: 'd 1' }],
      ['GET', `${B}?format=json`, undefined],
      ['GET', `${B}/related-work?q=a+plan&docId=d+1&limit=3`, undefined],
      ['GET', `${B}/related-work?q=a+plan`, undefined],
      ['PUT', `${B}/parallelism-cap`, { cap: 2, author: AUTHOR }],
    ]);
  });

  it('creates a board led by this session unless it names a lead', async () => {
    const r = recorder();
    const made = await r.run('create_workspace', { name: 'Riverbend' });
    await r.run('create_workspace', {
      name: 'Saltmarsh',
      leadAgentId: 'agent-bob',
      subscribe: false,
    });
    expect(r.calls).toEqual([
      ['POST', '/workspaces', { name: 'Riverbend', leadAgentId: AUTHOR.id }],
      ['POST', '/workspaces', { name: 'Saltmarsh', leadAgentId: 'agent-bob' }],
    ]);
    expect(made).toEqual({
      workspaceId: 'w 1',
      name: 'Riverbend',
      leadAgentId: 'agent-harborlight',
      url: '/workspaces/w%201',
    });
    expect(r.marks).toEqual(['watch w 1']);
  });

  it('reads the board record off its JSON answer', async () => {
    const r = recorder();
    expect(await r.run('get_workspace', {})).toEqual({
      workspaceId: 'w 1',
      name: 'Riverbend',
      leadAgentId: 'agent-harborlight',
      goals: [],
    });
  });
});

describe('the roster tools, through the typed client', () => {
  it('attaches as itself, acks each queued comment, and names itself', async () => {
    const r = recorder();
    await r.run('attach_agent', { capabilities: ['edit'] });
    await r.run('attach_agent', { agentId: 'agent-bob', subscribe: false });
    const ack = ['POST', `${B}/comment-queue/q%201/ack`, {}];
    expect(r.calls).toEqual([
      [
        'POST',
        `${B}/agents`,
        {
          agentId: AUTHOR.id,
          agentName: AUTHOR.name,
          runtime: 'claude-code-local',
          capabilities: ['edit'],
          pluginVersion: '9.9.9',
          processId: 'p-1',
        },
      ],
      ack,
      [
        'POST',
        `${B}/agents`,
        {
          agentId: 'agent-bob',
          runtime: 'claude-code-local',
          pluginVersion: '9.9.9',
          processId: 'p-1',
        },
      ],
      ack,
    ]);
    expect(r.marks).toEqual(['attached w 1', 'watch w 1']);
  });

  it('beats, leaves, answers a voice row and lists the roster', async () => {
    const r = recorder();
    const beat = await r.run('heartbeat', { agentId: 'agent bob', toolCallAt: 5 });
    await r.run('leave_workspace', {});
    await r.run('answer_voice', { queueId: 'v 1', text: ' yes ', written: '', minute: ' kept ' });
    await r.run('list_agents', {});
    expect(r.calls).toEqual([
      ['POST', `${B}/agents/agent%20bob/heartbeat`, { toolCallAt: 5 }],
      ['DELETE', `${B}/agents/agent-harborlight`, undefined],
      [
        'POST',
        `${B}/voice-queue/v%201/answer`,
        { agentId: AUTHOR.id, text: 'yes', minute: 'kept' },
      ],
      ['GET', `${B}/agents`, undefined],
    ]);
    expect(beat).toEqual({ workspaceId: 'w 1', agentId: 'agent bob' });
  });
});

describe('the dispatch and chat-audit tools, through the typed client', () => {
  it('sends each verb where the hand-spelled path did', async () => {
    const r = recorder();
    await r.run('get_unfiled_ask_count', { agent: 'Bob builder' });
    await r.run('publish_chat_audit', { entries: [{ agent: 'Bob', unfiledAsks: 1 }] });
    await r.run('register_dispatch', { taskId: 't 1', worktreePath: '/w', reason: '  ' });
    await r.run('register_dispatch', { taskId: 't 1', worktreePath: '/w', reason: ' top ' });
    await r.run('close_dispatch', { taskId: 't 1' });
    await r.run('report_dispatch', {
      taskId: 't 1',
      prNumber: 7,
      headCommit: 'abc',
      checks: [],
      doneWhen: [],
    });
    expect(r.calls).toEqual([
      ['GET', `${B}/chat-audit/Bob%20builder`, undefined],
      [
        'POST',
        `${B}/chat-audit`,
        { auditor: AUTHOR.name, entries: [{ agent: 'Bob', unfiledAsks: 1 }] },
      ],
      ['POST', `${B}/dispatches`, { taskId: 't 1', worktreePath: '/w', author: AUTHOR }],
      [
        'POST',
        `${B}/dispatches`,
        { taskId: 't 1', worktreePath: '/w', author: AUTHOR, reason: 'top' },
      ],
      ['DELETE', `${B}/dispatches/t%201`, undefined],
      [
        'POST',
        `${B}/dispatches/t%201/report`,
        {
          prNumber: 7,
          headCommit: 'abc',
          checks: [],
          doneWhen: [],
          agentName: AUTHOR.name,
          author: AUTHOR,
        },
      ],
    ]);
  });
});

describe('the doc, pointer, meeting and machine tools, through the typed client', () => {
  it('sends each verb where the hand-spelled path did', async () => {
    const r = recorder();
    await r.run('set_github_subscriptions', { subscriptions: [{ repo: 'o/r' }] });
    await r.run('set_board_embeds', { embeds: {} });
    await r.run('register_worktree', { path: '/r' });
    await r.run('list_worktrees', {});
    await r.run('unregister_worktree', { path: '/r' });
    await r.run('set_doc_title', { docId: 'd 1', title: 'Riverbend' });
    await r.run('get_doc_metadata', { docId: 'd 1' });
    await r.run('set_doc_metadata', { docId: 'd 1', fields: { status: 'draft' } });
    await r.run('set_doc_metadata', { docId: 'd 1' });
    await r.run('move_doc_to_project', { docId: 'd 1', relPath: 'notes/a.md' });
    await r.run('move_doc_file', { docId: 'd 1', path: '/n/a.md', mode: 'move' });
    await r.run('point_at', { taskId: ' t-1 ', scroll: 2 });
    await r.run('say_in_meeting', { text: ' hello ' });
    await r.run('coach_moment', { goal: 1, matched: 'm', observed: 'o', line: 'l?' });
    await r.run('rank_review_item', { key: 'k 1', rank: 3 });
    await r.run('rank_review_item', { key: 'k 1', goal: null });
    await r.run('request_plugin_refresh', {});
    const D = `${B}/docs/d%201`;
    expect(r.calls).toEqual([
      ['PUT', `${B}/github-subscriptions`, { subscriptions: [{ repo: 'o/r' }] }],
      ['PUT', `${B}/embeds`, { embeds: {} }],
      ['POST', '/api/repos/checkouts', { path: '/r' }],
      ['GET', '/api/repos', undefined],
      ['DELETE', '/api/repos/checkouts', { path: '/r' }],
      ['PUT', `${D}/title`, { title: 'Riverbend' }],
      ['GET', `${D}/metadata`, undefined],
      ['PUT', `${D}/metadata`, { fields: { status: 'draft' } }],
      ['PUT', `${D}/metadata`, { fields: {} }],
      ['POST', `${D}/move`, { relPath: 'notes/a.md' }],
      ['POST', `${D}/move-file`, { path: '/n/a.md', mode: 'move' }],
      [
        'POST',
        `${B}/point`,
        { agentId: AUTHOR.id, agentName: AUTHOR.name, taskId: 't-1', scroll: 2 },
      ],
      ['POST', `${B}/lead-chat/meeting/say`, { agentId: AUTHOR.id, text: 'hello' }],
      ['POST', '/coach/moments', { goal: 1, matched: 'm', observed: 'o', line: 'l?' }],
      ['POST', '/api/review-queue/rank', { agentId: AUTHOR.id, key: 'k 1', rank: 3 }],
      ['POST', '/api/review-queue/rank', { agentId: AUTHOR.id, key: 'k 1', goal: null }],
      ['POST', '/api/plugin/refresh', undefined],
    ]);
  });

  it('still answers a refusal as a result, not an error', async () => {
    const refused = recorder('POST /x → 409: {"error":"no-meeting","hint":"none"}');
    expect(await refused.run('say_in_meeting', { text: 'hello' })).toMatchObject({ said: false });
    expect(
      await refused.run('coach_moment', { goal: 1, matched: 'm', observed: 'o', line: 'l?' }),
    ).toEqual({ raised: false, reason: 'no-meeting' });
    const missing = recorder('POST /x → 404: {"error":"no-task"}');
    expect(await missing.run('point_at', { taskId: 't-1' })).toEqual({
      pointed: false,
      error: 'no-task',
    });
  });
});

/** Compiled, never run: a renamed field on either side fails the typecheck. */
function typeProbes(http: never) {
  const board = workspaceBoardClient(http).workspaces[':ws'];
  // @ts-expect-error the cap PUT takes `cap`, not `limit`
  board['parallelism-cap'].$put({ param: { ws: 'w' }, json: { limit: 2 } });
  const roster = workspaceAgentsClient(http).workspaces[':ws'];
  // @ts-expect-error a heartbeat's clock field is `toolCallAt`
  roster.agents[':agentId'].heartbeat.$post({ param: { ws: 'w', agentId: 'a' }, json: { at: 1 } });
  const lanes = dispatchesClient(http).workspaces[':ws'];
  // @ts-expect-error a dispatch names its task by `taskId`
  lanes.dispatches.$post({ param: { ws: 'w' }, json: { task: 't', worktreePath: '/w' } });
  const doc = docFileClient(http).workspaces[':ws'].docs[':docId'];
  // @ts-expect-error a move names its target by `relPath`
  doc.move.$post({ param: { ws: 'w', docId: 'd' }, json: { path: 'a.md' } });
  const moments = agentMachineClient(http).coach.moments;
  // @ts-expect-error the coach reads `observed`, not `seen`
  moments.$post({ json: { goal: 1, matched: 'm', seen: 'o', line: 'l' } });
}
void typeProbes;
