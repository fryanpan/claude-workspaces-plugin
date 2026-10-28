/**
 * Every MCP tool that makes or attaches something answers with `url`: the
 * absolute link to what it made, on the server's public host.
 *
 * An agent hands that link to a person. When a tool answered without one the
 * agent sent the board's home link instead, and the person had to go and
 * find the thing. One field name for every tool is what lets an agent hand it
 * on without remembering which tool spelled it `reviewUrl`, `entryUrl` or
 * `threadUrl` (those stay, beside it).
 *
 * The list is ENUMERATED from the tool registry, not written out here: a new
 * `create_*` / `attach_*` tool, or any other name the predicate below picks
 * up, fails this file until it is either driven here or exempted with a
 * reason. Each case runs the MCP tool's own handler against a real server, so
 * a handler that reshapes the server's answer and drops the field fails too.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from '../../mcp/src/call-tool.ts';
import { TOOL_LIST } from '../../mcp/src/tool-schemas.ts';
import { handleDocsTool } from '../../mcp/src/tools/docs.ts';
import { handleTaskTool } from '../../mcp/src/tools/tasks.ts';
import { handleWhiteboardTool } from '../../mcp/src/tools/whiteboard.ts';
import { handleWorkspaceTool } from '../../mcp/src/tools/workspace.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const PUBLIC = 'https://harborlight.example';
const SHARE_HOST = 'share.harborlight.example';
const AGENT = { id: 'agent:riverbend', name: 'Riverbend', kind: 'agent' as const, color: '#888' };

/** Tools that make or attach something, by name. */
const MAKES_SOMETHING = /^(create_|attach_|spin_off_|import_|add_review_item$|post_reply$|share_)/;

/**
 * Picked up by the predicate but make nothing a person could open, and why.
 * Adding a name here is a decision a reviewer reads.
 */
const EXEMPT: Record<string, string> = {
  create_anchor:
    "an agent's own bookmark inside a doc: nobody opens it, and the doc's url came back when the doc was attached",
  attach_agent:
    'registers this session on a board it already names; it makes no page, and the board url came back from create_workspace',
};

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

describe('every make-or-attach tool answers with url', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let fixtures: string;
  let base: string;
  let WS = '';
  let repo = '';
  let repoBase = '';
  let taskId = '';
  let threadDoc = '';
  let threadId = '';

  const http = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`);
    return text === '' ? {} : JSON.parse(text);
  };
  const ok = (data: unknown): CallToolResult => ({
    content: [{ type: 'text', text: JSON.stringify(data) }],
  });
  const err = (message: string): CallToolResult => ({
    isError: true,
    content: [{ type: 'text', text: message }],
  });
  const ctx = (): ToolContext =>
    ({
      http,
      ok,
      err,
      AUTHOR: AGENT,
      CWD: fixtures,
      DEFAULT_WORKSPACE_ID: '',
      STATUS_TEXT_MAX: 2000,
      suggestionAuthor: () => ({ id: AGENT.id, name: AGENT.name, color: AGENT.color }),
      resolveBaseUrl: () => base,
      watchers: new Map(),
      watchDoc: async () => true,
      watchWorkspace: async () => ({ open: true, persisted: false }),
      unwatchDoc: async () => true,
      refreshCoverage: async () => undefined,
      restoreState: 'done',
      lastPersistError: undefined,
      watchPersistenceMode: () => 'session-only',
      streamMode: () => 'per-key',
      IDENTITY_IS_SHARED: false,
      SHARED_IDENTITY_REASON: '',
      claimNoticeFor: async () => undefined,
      PLUGIN_VERSION: '0.0.0-test',
      PROCESS_ID: 'p-test',
      markAttached: () => {},
      markDetached: () => {},
    }) as unknown as ToolContext;

  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    for (const h of [handleDocsTool, handleTaskTool, handleWhiteboardTool, handleWorkspaceTool]) {
      const res = await h(name, args, ctx());
      if (res === undefined) continue;
      const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? '';
      if (res.isError) throw new Error(`${name}: ${text}`);
      return JSON.parse(text);
    }
    throw new Error(`no handler for ${name}`);
  };

  /** Each tool's call, and where in its answer the link sits. */
  const DRIVERS: Record<string, () => Promise<unknown>> = {
    create_workspace: () => call('create_workspace', { name: 'Saltmarsh board', subscribe: false }),
    attach_markdown: () => {
      const path = join(fixtures, 'plan.md');
      writeFileSync(path, '# Plan\n\nHarborlight.\n');
      return call('attach_markdown', { workspaceId: WS, docId: 'dut-plan', path });
    },
    attach_mockup: () => {
      const path = join(fixtures, 'mock.html');
      writeFileSync(path, '<h1>Riverbend</h1>\n');
      return call('attach_mockup', { workspaceId: WS, docId: 'dut-mock', sourceHtmlPath: path });
    },
    attach_app: () =>
      call('attach_app', { workspaceId: WS, docId: 'dut-app', origin: 'http://127.0.0.1:5999' }),
    attach_folder: () => {
      const dir = join(fixtures, 'folder');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'README.md'), '# Folder\n');
      return call('attach_folder', { workspaceId: WS, folderPath: dir, subscribe: false });
    },
    create_diff_review: () =>
      call('create_diff_review', { workspaceId: WS, repo, base: repoBase, subscribe: false }),
    attach_doc: async () => {
      const other = await seedBoard(base, { name: 'Riverbend board' });
      return call('attach_doc', { workspaceId: other, docId: 'dut-plan' });
    },
    create_whiteboard: () => call('create_whiteboard', { workspaceId: WS, title: 'Sketch' }),
    create_thread: () =>
      call('create_thread', { workspaceId: WS, docId: threadDoc, text: 'A question.' }),
    post_reply: () =>
      call('post_reply', { workspaceId: WS, docId: threadDoc, threadId, text: 'An answer.' }),
    create_tasks: () =>
      call('create_tasks', {
        workspaceId: WS,
        tasks: [{ title: 'Rename the dock', body: 'Agent can rename the dock so that it reads.' }],
      }),
    spin_off_task: () =>
      call('spin_off_task', { workspaceId: WS, docId: threadDoc, threadId, title: 'Spun off' }),
    add_review_item: () =>
      call('add_review_item', {
        workspaceId: WS,
        taskId,
        review: {
          review_type: 'question',
          headline: 'Which dock name reads best',
          detail: 'Pick one.',
        },
      }),
    import_tasks_markdown: () => {
      const path = join(fixtures, 'tasks.md');
      writeFileSync(path, '# Tasks\n\n- [ ] Paint the Saltmarsh sign\n');
      return call('import_tasks_markdown', { workspaceId: WS, path, apply: true });
    },
    share_workspace: () => call('share_workspace', { workspaceId: WS }),
  };

  /** The link, wherever the tool's answer shape puts it. */
  const urlOf = (name: string, res: unknown): unknown => {
    const r = res as { url?: unknown; created?: Array<{ url?: unknown }> };
    if (name === 'create_tasks') return r.created?.[0]?.url;
    return r.url;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'dut-data-'));
    fixtures = mkdtempSync(join(tmpdir(), 'dut-fx-'));
    repo = join(fixtures, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.ts'), 'const a = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    repoBase = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.ts'), 'const a = 2;\n');

    handle = createServer({
      port: 0,
      dataDir,
      publicBaseUrl: PUBLIC,
      shareLinkHosts: [SHARE_HOST],
    });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base, { name: 'Harborlight board' });

    // A task and a thread for the verbs that act on one.
    const made = (await call('create_tasks', {
      workspaceId: WS,
      tasks: [{ title: 'Seed row', body: 'Agent can seed a row so that tests have one.' }],
    })) as { created: Array<{ taskId: string }> };
    taskId = made.created[0]?.taskId ?? '';
    threadDoc = `task:${taskId}`;
    const opened = (await call('create_thread', {
      workspaceId: WS,
      docId: threadDoc,
      text: 'Seed thread.',
    })) as { thread?: { id?: string }; threadId?: string };
    threadId = opened.thread?.id ?? opened.threadId ?? '';
    expect(threadId).not.toBe('');
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fixtures, { recursive: true, force: true });
  });

  const picked = TOOL_LIST.tools.map((t) => t.name).filter((n) => MAKES_SOMETHING.test(n));

  it('the registry lists the tools this file drives', () => {
    // A positive control on the predicate: it must pick up the tools named
    // in the task, or every per-tool case below is vacuous.
    expect(picked).toContain('create_diff_review');
    expect(picked).toContain('attach_markdown');
    const unhandled = picked.filter((n) => !(n in DRIVERS) && !(n in EXEMPT));
    expect(unhandled).toEqual([]);
  });

  it('every one names url in its description', () => {
    const missing = TOOL_LIST.tools
      .filter((t) => t.name in DRIVERS)
      .filter((t) => !(t.description ?? '').includes('`url`'))
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  // Order matters: attach_doc files the doc attach_markdown made, so the
  // drivers run in the order written.
  for (const name of Object.keys(DRIVERS)) {
    it(`${name} answers with an absolute url on the public host`, async () => {
      const driver = DRIVERS[name];
      if (!driver) throw new Error(`no driver for ${name}`);
      const res = await driver();
      const url = urlOf(name, res);
      expect(typeof url, `${name} answered ${JSON.stringify(res).slice(0, 400)}`).toBe('string');
      const parsed = new URL(url as string);
      const host = name === 'share_workspace' ? `https://${SHARE_HOST}` : PUBLIC;
      expect(parsed.origin).toBe(host);
    });
  }
});
