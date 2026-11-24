/**
 * A session's MCP child as a relay: the compiled one and the node fallback,
 * each driven over stdio against a real server, through the plugin launcher.
 *
 * What each arm has to show, and why each is here:
 *
 * - tools list and call through `/mcp`, as the session's own directory;
 * - a comment pushed on the server comes out of the relay as the same
 *   `notifications/claude/channel` line today's full child writes for it —
 *   the push is the whole reason a session keeps a child at all;
 * - `/mcp` refuses a request without the agent's token, even on a server that
 *   still serves tokenless callers elsewhere, and a relay whose mint is
 *   refused gets no tools rather than someone else's;
 * - a server restart, and a server that is not up yet, cost the session no
 *   tools and no pushes.
 *
 * The compiled arm runs only on a Mac that can build it; the node arm runs
 * everywhere. All fixtures synthetic; port 0; no production server, discovery
 * file or plugin cache is touched — every child gets a temp HOME.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgentAuthor } from '../../mcp/src/author.ts';
import { TOOL_LIST } from '../../mcp/src/tool-schemas.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { identityHeaders, initializeBody } from './connector-harness.ts';
import {
  type ChildArm,
  FULL_ARM,
  type StdioChild,
  compiledArm,
  nodeRelayArm,
  startChild,
} from './relay-harness.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const ALPHA = 'Riverbend Alpha';
const ALPHA_ID = resolveAgentAuthor({ CW_AGENT_NAME: ALPHA, CW_AUTHOR: 'agent' }).id;
/** Not ASCII: é fits one Latin-1 byte, so a header carries it mangled rather than refused. */
const CAFE = 'Riverbend café';
const CAFE_ID = resolveAgentAuthor({ CW_AGENT_NAME: CAFE, CW_AUTHOR: 'agent' }).id;
const BETA_ID = resolveAgentAuthor({ CW_AGENT_NAME: 'Harborlight Beta', CW_AUTHOR: 'agent' }).id;
const PERSON = {
  id: 'known-reviewer',
  name: 'Saltmarsh Reviewer',
  kind: 'known',
  color: '#2e7dd7',
};

const ARMS: ChildArm[] = [compiledArm(), nodeRelayArm()].filter((a): a is ChildArm => a !== null);

let dataDir: string;
let workDir: string;
let handles: ServerHandle[] = [];
let children: StdioChild[] = [];

/**
 * The server, with the token NOT required: `/mcp` must refuse a tokenless
 * agent anyway. The mint's process probe is stood in for — the caller is
 * `callerId` (agent-token-mint.test.ts drives the real probe).
 */
function boot(port = 0, callerId = ALPHA_ID): { handle: ServerHandle; base: string } {
  const handle = createServer({
    port,
    dataDir,
    requireAgentToken: false,
    identifyAgentCaller: async () => ({ ok: true, agentId: callerId, via: 'session' }),
  });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}

function start(arm: ChildArm, base: string, extra: Record<string, string> = {}): StdioChild {
  const child = startChild(arm, { CW_BASE_URL: base, CW_AGENT_NAME: ALPHA, ...extra }, workDir);
  children.push(child);
  return child;
}

async function makeDoc(base: string, ws: string, alias: string): Promise<string> {
  const path = join(workDir, `${alias}.md`);
  writeFileSync(path, `# ${alias}\n\nBody.\n`);
  const res = await fetch(`${base}/workspaces/${ws}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: alias, sourceUrl: path, title: alias }),
  });
  return ((await res.json()) as { docId: string }).docId;
}

function comment(base: string, ws: string, docId: string, text: string): Promise<Response> {
  return fetch(`${base}/workspaces/${ws}/docs/${docId}/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: PERSON, text, anchor: { kind: 'subject' } }),
  });
}

const channelWith = (c: StdioChild, text: string) =>
  c.channel().find((p) => String(p.content).includes(text));

beforeAll(() => {
  // Real path: a child reports the directory the OS gives it, with /private.
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-stdio-work-')));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe.each(ARMS)('the $kind relay', (arm) => {
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'relay-stdio-data-'));
  });
  afterEach(async () => {
    for (const c of children) await c.stop();
    for (const h of handles) await h.stop();
    children = [];
    handles = [];
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is the child the launcher chose', async () => {
    const { base } = boot();
    const child = start(arm, base);
    await child.handshake();
    const banner = arm.kind === 'compiled' ? 'compiled relay started' : 'node relay started';
    await waitFor(() => child.stderr().includes(banner), { describe: banner });
  }, 30_000);

  it('lists and calls the board tools through /mcp, as the session’s directory', async () => {
    const { handle, base } = boot();
    const ws = await seedBoard(base);
    const child = start(arm, base, { CW_WORKSPACE_ID: ws });
    const init = await child.handshake();
    const result = init.result as { serverInfo: { name: string }; instructions: string };
    expect(result.serverInfo.name).toBe('claude-workspaces');
    // The server's own instructions, so this answer came from /mcp.
    expect(result.instructions.length).toBeGreaterThan(200);

    const listed = await child.request('tools/list');
    const names = (listed.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(TOOL_LIST.tools.map((t) => t.name));

    const path = join(workDir, 'plan.md');
    writeFileSync(path, '# Plan\n\nThe second paragraph.\n');
    const bound = await child.callTool('attach_markdown', { workspaceId: ws, docId: 'plan', path });
    expect(bound.isError).toBe(false);
    const docId = (JSON.parse(bound.text) as { docId: string }).docId;
    expect(handle.docStore.peekMeta(docId)?.owner).toBe(workDir);
  }, 30_000);

  it('writes a pushed comment as the same channel line today’s child writes', async () => {
    const { base } = boot();
    const ws = await seedBoard(base);
    const docId = await makeDoc(base, ws, 'pushed');
    const relay = start(arm, base);
    const full = start(FULL_ARM, base, { CW_AGENT_NAME: 'Harborlight Beta' });
    for (const c of [relay, full]) {
      await c.handshake();
      expect((await c.callTool('watch_doc', { docId })).isError).toBe(false);
    }
    // Both are subscribed once each has reported its stream; a positive control
    // on both connections before the comment under test.
    await comment(base, ws, docId, 'control line');
    await waitFor(() => channelWith(relay, 'control line') && channelWith(full, 'control line'), {
      timeout: 10_000,
      describe: 'the control comment on both children',
    });

    await comment(base, ws, docId, 'tighten this paragraph');
    const [fromRelay, fromFull] = await waitFor(
      () => {
        const a = channelWith(relay, 'tighten this paragraph');
        const b = channelWith(full, 'tighten this paragraph');
        return a && b ? [a, b] : null;
      },
      { timeout: 10_000, describe: 'the comment on both children' },
    );
    expect(fromRelay?.content).toBe(fromFull?.content);
    expect(fromRelay?.meta).toEqual(fromFull?.meta);
    expect(relay.channel().filter((p) => String(p.content).includes('tighten this')).length).toBe(
      1,
    );
  }, 40_000);

  it('stays on the relay for a name and a directory that are not ASCII, and the server reads both', async () => {
    // The mint is answered only for café's own id, so a name that arrived
    // mangled is refused and the session gets no tools.
    const { handle, base } = boot(0, CAFE_ID);
    const ws = await seedBoard(base);
    // Decomposed: u + U+0308, as macOS tools often write it. A character above
    // U+00FF is what a header cannot carry; an NFC ü fits one Latin-1 byte and
    // round-trips by accident.
    const dir = join(workDir, 'Projekt-u\u0308ber');
    mkdirSync(dir, { recursive: true });
    const child = startChild(
      arm,
      { CW_BASE_URL: base, CW_AGENT_NAME: CAFE, CW_WORKSPACE_ID: ws },
      dir,
    );
    children.push(child);
    await child.handshake();
    const banner = arm.kind === 'compiled' ? 'compiled relay started' : 'node relay started';
    await waitFor(() => child.stderr().includes(banner), { describe: banner });
    const listed = await child.request('tools/list');
    expect((listed.result as { tools: unknown[] }).tools.length).toBe(TOOL_LIST.tools.length);

    const path = join(dir, 'notes.md');
    writeFileSync(path, '# Notes\n\nBody.\n');
    const bound = await child.callTool('attach_markdown', {
      workspaceId: ws,
      docId: 'notes',
      path,
    });
    expect(bound.isError).toBe(false);
    const docId = (JSON.parse(bound.text) as { docId: string }).docId;
    expect(handle.docStore.peekMeta(docId)?.owner).toBe(dir);
  }, 30_000);

  it('gets no tools when its token mint is refused', async () => {
    // The probe says the caller is somebody else, so Alpha's mint is refused.
    const { base } = boot(0, BETA_ID);
    const child = start(arm, base, { CW_RELAY_INIT_WAIT_MS: '0' });
    await child.handshake();
    const listed = await child.request('tools/list');
    expect((listed.result as { tools: unknown[] }).tools).toEqual([]);
    const called = await child.callTool('list_watched_docs', {});
    expect(called.isError).toBe(true);
    expect(called.text).toContain('agent-token-required');
  }, 30_000);

  it('keeps its tools and its pushes across a server restart', async () => {
    const first = boot();
    const port = first.handle.port;
    const ws = await seedBoard(first.base);
    const docId = await makeDoc(first.base, ws, 'restart');
    const child = start(arm, first.base);
    await child.handshake();
    await child.callTool('watch_doc', { docId });
    await first.handle.stop();
    handles = [];

    const second = boot(port);
    expect(second.handle.port).toBe(port);
    const listed = await child.request('tools/list', {}, 20_000);
    expect((listed.result as { tools: unknown[] }).tools.length).toBe(TOOL_LIST.tools.length);
    await comment(second.base, ws, docId, 'after the restart');
    await waitFor(() => channelWith(child, 'after the restart'), {
      timeout: 20_000,
      describe: 'a comment posted after the restart',
    });
  }, 60_000);

  it('answers a session that starts before the server, and lists the tools once it is up', async () => {
    // A port that is free now and bound by the server a moment later.
    const probe = boot();
    const port = probe.handle.port;
    await probe.handle.stop();
    handles = [];
    const child = start(arm, `http://127.0.0.1:${port}`, { CW_RELAY_INIT_WAIT_MS: '0' });
    const init = await child.handshake();
    expect(
      (init.result as { capabilities: { tools: { listChanged: boolean } } }).capabilities.tools
        .listChanged,
    ).toBe(true);
    expect(((await child.request('tools/list')).result as { tools: unknown[] }).tools).toEqual([]);

    boot(port);
    await waitFor(
      () => child.messages.some((m) => m.method === 'notifications/tools/list_changed'),
      {
        timeout: 20_000,
        describe: 'tools/list_changed once the server is up',
      },
    );
    const listed = await child.request('tools/list');
    expect((listed.result as { tools: unknown[] }).tools.length).toBe(TOOL_LIST.tools.length);
  }, 60_000);
});

describe('/mcp and the agent token', () => {
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'relay-stdio-token-'));
  });
  afterEach(async () => {
    for (const h of handles) await h.stop();
    handles = [];
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses a named agent without its token, on a server that does not require one elsewhere', async () => {
    const { base } = boot();
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(initializeBody()),
      });
    const bare = await post(identityHeaders(ALPHA, workDir));
    expect(bare.status).toBe(401);
    expect(((await bare.json()) as { error: string }).error).toBe('agent-token-required');

    // Control: the relay's mint, addressed by the same headers, opens it.
    const minted = await fetch(`${base}/api/agent-token`, {
      headers: identityHeaders(ALPHA, workDir),
    });
    expect(minted.status).toBe(200);
    const { agentId, token } = (await minted.json()) as { agentId: string; token: string };
    expect(agentId).toBe(ALPHA_ID);
    const opened = await post({
      ...identityHeaders(ALPHA, workDir),
      authorization: `Bearer ${token}`,
    });
    expect(opened.status).toBe(200);
    expect(opened.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('mints by headers only for the calling session’s own agent', async () => {
    const { base } = boot(0, BETA_ID);
    const res = await fetch(`${base}/api/agent-token`, {
      headers: identityHeaders(ALPHA, workDir),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('agent-token-not-yours');
    const unnamed = await fetch(`${base}/api/agent-token`, {
      headers: identityHeaders(null, workDir),
    });
    expect(unnamed.status).toBe(400);
    const noCwd = await fetch(`${base}/api/agent-token`, { headers: { 'x-cw-agent': ALPHA } });
    expect(noCwd.status).toBe(400);
  });
});
