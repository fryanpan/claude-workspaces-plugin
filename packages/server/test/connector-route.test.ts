/**
 * `/mcp` through a real server: who may reach it, a real MCP client using it,
 * and what a restart does to an agent's pushes.
 *
 * The restart case is the reason the connector moved into the server. With a
 * connector per Claude Code session, a comment posted in the moments after a
 * server restart reached nobody: the child's event stream was still redialling
 * and nothing was subscribed on the agent's behalf. Here the stopping server
 * writes down who it was hosting and the booting one subscribes them before it
 * answers anything, so the comment waits in the agent's outbox until its client
 * comes back — and arrives once.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveAgentAuthor } from '../../mcp/src/author.ts';
import { TOOL_LIST } from '../../mcp/src/tool-schemas.ts';
import type { ConnectorHost } from '../src/connector/host.ts';
import { snapshotPath } from '../src/connector/snapshot.ts';
import { handleMcpConnectorRoute } from '../src/routes/mcp-connector.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  type Send,
  identityHeaders,
  initialize,
  listen,
  openStream,
  rpc,
} from './connector-harness.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const ALPHA_ID = resolveAgentAuthor({ CW_AGENT_NAME: 'Riverbend Alpha', CW_AUTHOR: 'agent' }).id;
const PERSON = {
  id: 'known-reviewer',
  name: 'Saltmarsh Reviewer',
  kind: 'known',
  color: '#2e7dd7',
};

describe('/mcp gate', () => {
  let handled = 0;
  const host = {
    handle: async () => {
      handled += 1;
      return new Response('handled');
    },
  } as unknown as ConnectorHost;
  const ctx = (address: string) => ({
    host,
    j: (status: number, body: unknown) => Response.json(body, { status }),
    requestAddress: () => address,
  });
  const call = (
    headers: Record<string, string>,
    opts: { address?: string; visitor?: unknown } = {},
  ) =>
    handleMcpConnectorRoute(ctx(opts.address ?? '127.0.0.1'), {
      req: new Request('http://127.0.0.1/mcp', { method: 'POST', headers }),
      pathname: '/mcp',
      visitor: opts.visitor ?? null,
    });

  beforeEach(() => {
    handled = 0;
  });

  it('hands a local agent process to the host', async () => {
    expect(await (await call({}))?.text()).toBe('handled');
    expect(handled).toBe(1);
  });

  it('refuses a request that crossed the edge', async () => {
    const res = await call({ 'cf-ray': '0000000000000000-LAX' });
    expect(res?.status).toBe(403);
    expect(handled).toBe(0);
  });

  it('refuses a caller off this machine', async () => {
    const res = await call({}, { address: '192.0.2.10' });
    expect(res?.status).toBe(403);
    expect(handled).toBe(0);
  });

  it('refuses a page', async () => {
    const res = await call({ origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-site' });
    expect(res?.status).toBe(403);
    expect(handled).toBe(0);
  });

  it('refuses a share visitor', async () => {
    const res = await call({}, { visitor: { shareId: 'share-1' } });
    expect(res?.status).toBe(403);
    expect(handled).toBe(0);
  });

  it('declines every other path', async () => {
    const res = await handleMcpConnectorRoute(ctx('127.0.0.1'), {
      req: new Request('http://127.0.0.1/mcp/extra'),
      pathname: '/mcp/extra',
      visitor: null,
    });
    expect(res).toBeNull();
  });
});

describe('/mcp on a real server', () => {
  let dataDir: string;
  let srcDir: string;
  let handles: ServerHandle[] = [];

  const boot = (): { handle: ServerHandle; base: string; send: Send } => {
    const handle = createServer({ port: 0, dataDir });
    handles.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;
    const send: Send = (method, headers, body) =>
      fetch(`${base}/mcp`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { handle, base, send };
  };

  const makeDoc = async (base: string, ws: string, alias: string): Promise<string> => {
    const path = join(srcDir, `${alias}.md`);
    writeFileSync(path, `# ${alias}\n\nBody.\n`);
    const res = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: alias, sourceUrl: path, title: alias }),
    });
    return ((await res.json()) as { docId: string }).docId;
  };

  const comment = (base: string, ws: string, docId: string, text: string) =>
    fetch(`${base}/workspaces/${ws}/docs/${docId}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: PERSON, text, anchor: { kind: 'subject' } }),
    });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'connector-route-'));
    srcDir = mkdtempSync(join(tmpdir(), 'connector-route-src-'));
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) await h.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('serves the MCP SDK client: tools, a bind as this directory, and a comment pushed once', async () => {
    const { handle, base } = boot();
    const ws = await seedBoard(base);
    const cwd = '/work/riverbend';
    const received: string[] = [];
    const client = new Client({ name: 'connector-e2e', version: '0.0.0' });
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/claude/channel') {
        received.push(String((n.params as { content?: unknown }).content));
      }
    };
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: identityHeaders('Riverbend Alpha', cwd) },
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(TOOL_LIST.tools.map((t) => t.name));

      const path = join(srcDir, 'plan.md');
      writeFileSync(path, '# Plan\n\nThe second paragraph.\n');
      const bound = await client.callTool({
        name: 'attach_markdown',
        arguments: { workspaceId: ws, docId: 'plan', path },
      });
      expect(bound.isError).not.toBe(true);
      const text = (bound.content as { type: string; text: string }[])[0]?.text ?? '{}';
      const docId = (JSON.parse(text) as { docId: string }).docId;
      // The session's own directory, not the server's.
      expect(handle.docStore.peekMeta(docId)?.owner).toBe(cwd);

      // The bind's own auto-watch runs before the doc exists, as it does for
      // the stdio child; subscribe to the doc the bind made.
      const watched = await client.callTool({ name: 'watch_doc', arguments: { docId } });
      expect(watched.isError).not.toBe(true);
      await waitFor(() => handle.agentWatches.list(ALPHA_ID, () => true).watches.length > 0, {
        describe: 'the bind to subscribe the agent',
      });
      await waitFor(() => handle.connector.counts().streams === 1, {
        describe: 'the client GET stream',
      });
      await comment(base, ws, docId, 'tighten this');
      await waitFor(() => received.some((t) => t.includes('tighten this')), { timeout: 10_000 });
      // A positive control on the same connection before counting.
      await comment(base, ws, docId, 'control');
      await waitFor(() => received.some((t) => t.includes('control')), { timeout: 10_000 });
      expect(received.filter((t) => t.includes('tighten this')).length).toBe(1);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('carries a comment posted right after a restart to the agent, once', async () => {
    const alpha = identityHeaders('Riverbend Alpha', '/work/riverbend');
    const first = boot();
    const ws = await seedBoard(first.base);
    const docId = await makeDoc(first.base, ws, 'doc-one');
    const sid = await initialize(first.send, alpha);
    const watched = await rpc(first.send, sid, alpha, 'tools/call', {
      name: 'watch_doc',
      arguments: { docId },
    });
    expect(watched.status).toBe(200);
    const before = listen(await openStream(first.send, sid, alpha));
    await comment(first.base, ws, docId, 'before the restart');
    await waitFor(() => before.channelTexts().some((t) => t.includes('before the restart')), {
      timeout: 10_000,
    });
    const lastId = before.events.filter((e) => e.message).at(-1)?.id as string;
    before.stop();
    await first.handle.stop();
    handles = [];

    // The snapshot: who, never how to prove it.
    const file = snapshotPath(dataDir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      identities: Record<string, unknown>[];
    };
    expect(saved.identities).toEqual([
      { agent: 'Riverbend Alpha', cwd: '/work/riverbend', pluginVersion: '0.1.999' },
    ]);

    // Posted before the client has reconnected — before `/mcp` has seen a
    // single request on this process.
    const second = boot();
    expect((await comment(second.base, ws, docId, 'right after the restart')).ok).toBe(true);

    const after = listen(await openStream(second.send, sid, alpha, lastId));
    try {
      await waitFor(() => after.channelTexts().some((t) => t.includes('right after the restart')), {
        timeout: 10_000,
        describe: 'the comment posted before the client came back',
      });
      await comment(second.base, ws, docId, 'control');
      await waitFor(() => after.channelTexts().some((t) => t.includes('control')), {
        timeout: 10_000,
      });
      expect(after.channelTexts().filter((t) => t.includes('right after the restart')).length).toBe(
        1,
      );
      expect(after.channelTexts().some((t) => t.includes('before the restart'))).toBe(false);
    } finally {
      after.stop();
    }
  }, 30_000);
});
