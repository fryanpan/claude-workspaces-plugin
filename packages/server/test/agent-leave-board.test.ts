/**
 * An agent can leave a board, Bryan can remove one, and neither comes back on
 * the next restart — driven through the REAL server and the MCP child's own
 * restore (`watch-restore.ts`), with nothing between them but HTTP.
 *
 * The restore is what used to undo a removal. It re-wires the watch set the
 * server keeps for an agent and re-attaches to the boards that set names, so
 * a row whose `ws:` key outlived it was back within seconds of every deploy.
 * The other half is the dormant row nobody removed: an agent attached once,
 * not the lead, and has done nothing on the board since — the restore leaves
 * that one alone too, while a lead and an agent that worked there still come
 * back.
 *
 * The registry handed to the restore records what it would wire rather than
 * opening streams; the watch set, the coverage and every attach are the
 * server's own. All names are fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeferredEmitter } from '../../mcp/src/deferred-emit.ts';
import { createHttp } from '../../mcp/src/http-client.ts';
import { handleWorkspaceTool } from '../../mcp/src/tools/workspace.ts';
import type { WatchCoverage } from '../../mcp/src/watch-coverage.ts';
import type { WatchRegistry } from '../../mcp/src/watch-registry.ts';
import { createWatchRestore } from '../../mcp/src/watch-restore.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

const LEAD = { id: 'agent-harborlight', name: 'Harborlight' };
const GUEST = { id: 'agent-riverbend', name: 'Riverbend' };
const WORKER = { id: 'agent-saltmarsh', name: 'Saltmarsh' };

let dataDir = '';
let server: ServerHandle;
let base = '';

// Every heartbeat reads stale at once, as each would after a real restart:
// the restore re-attaches only to a board it is not live on.
const boot = () => {
  server = createServer({ port: 0, dataDir, heartbeatFreshMs: 1 });
  base = `http://127.0.0.1:${server.port}`;
};

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** Attach as the MCP does, and record the board's key in the watch set.
 *  Returns the attach's own timestamp. */
const join_ = async (ws: string, who: { id: string; name: string }): Promise<number> => {
  const a = await call('POST', `/workspaces/${ws}/agents`, {
    agentId: who.id,
    agentName: who.name,
    runtime: 'claude-code-local',
  });
  expect(a.status).toBe(200);
  const w = await call('POST', `/api/agents/${who.id}/watches`, { add: [`ws:${ws}`] });
  expect(w.status).toBe(200);
  return (a.body.attachment as { attachedAt: number }).attachedAt;
};

/**
 * Wait until the server's clock has moved past an attach. "Worked since
 * attach" is `lastBoardWorkAt > attachedAt` in milliseconds, so work filed in
 * the attach's own millisecond reads as no work at all, and the restore leaves
 * the row dormant. On a warm run the two land in the same millisecond about
 * one time in five.
 */
const pastAttach = (attachedAt: number) =>
  waitFor(() => Date.now() > attachedAt, { describe: `the clock to pass ${attachedAt}` });

const agentsOn = async (ws: string): Promise<string[]> => {
  const r = await call('GET', `/workspaces/${ws}/agents`);
  return ((r.body.attachments ?? r.body.agents ?? []) as Array<{ agentId: string }>).map(
    (a) => a.agentId,
  );
};

const watchKeys = async (who: { id: string }): Promise<string[]> => {
  const r = await call('GET', `/api/agents/${who.id}/watches`);
  return ((r.body.watches ?? []) as Array<{ key: string }>).map((w) => w.key);
};

/**
 * A respawned session's restore, run as `who`. Returns the boards it wired a
 * board stream for and the boards it POSTed an attachment to.
 */
async function restoreAs(who: { id: string; name: string }) {
  const http = createHttp(() => base);
  const attachPosts: string[] = [];
  const recording = async (method: string, path: string, body?: unknown) => {
    const m = path.match(/^\/workspaces\/([^/]+)\/agents$/);
    if (method === 'POST' && m) attachPosts.push(decodeURIComponent(m[1] ?? ''));
    return http(method, path, body);
  };
  const wired: string[] = [];
  let coverage: WatchCoverage | undefined;
  const registry: WatchRegistry = {
    watchDoc: async (docId) => {
      wired.push(docId);
      return true;
    },
    watchWorkspace: async (workspaceId) => {
      wired.push(`ws:${workspaceId}`);
      return { open: true, persisted: false };
    },
    unwatchDoc: async () => true,
    streamMode: () => 'multiplexed',
    refreshCoverage: async () => coverage,
    coverage: () => coverage,
    setCoverage: (next) => {
      coverage = next;
    },
    watchPersistenceMode: () => 'server',
    lastPersistError: () => undefined,
  };
  const restore = createWatchRestore({
    http: recording,
    registry,
    watchers: new Map(),
    author: who,
    pluginVersion: '0.0.0-test',
    processId: `respawn-${who.id}`,
    markAttached: () => {},
    notify: async () => {},
    emitChannelMessage: async () => {},
    shouldForward: () => true,
    deferredEmits: createDeferredEmitter((fn) => fn()),
    identityIsShared: false,
  });
  await restore.ensureWatchesRestored();
  expect(restore.state().status).toBe('restored');
  return { wired, attachPosts };
}

/** The `leave_workspace` arm, as the session named `who` would call it. */
async function leave(ws: string, who: { id: string; name: string }) {
  const http = createHttp(() => base);
  const unwatched: string[] = [];
  const detached: string[] = [];
  const res = await handleWorkspaceTool(
    'leave_workspace',
    { workspaceId: ws },
    {
      http,
      ok: (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
      err: (message) => ({ content: [{ type: 'text', text: message }], isError: true }),
      AUTHOR: { ...who, color: '#000000', kind: 'known' },
      PLUGIN_VERSION: '0.0.0-test',
      PROCESS_ID: 'p',
      IDENTITY_IS_SHARED: false,
      markAttached: () => {},
      markDetached: (id) => detached.push(id),
      unwatchDoc: async (key) => {
        unwatched.push(key);
        return true;
      },
      watchWorkspace: async () => ({ open: true, persisted: true }),
    },
  );
  const text = (res?.content[0] as { text: string } | undefined)?.text ?? '';
  return { result: JSON.parse(text) as Record<string, unknown>, unwatched, detached };
}

type Frame = { event: string; data: Record<string, unknown> };

/** Read SSE frames off an agent's own stream as they arrive. */
async function listenAs(who: { id: string }) {
  const res = await fetch(`${base}/events/agent/${encodeURIComponent(who.id)}`);
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        for (let sep = buf.indexOf('\n\n'); sep >= 0; sep = buf.indexOf('\n\n')) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          if (raw.startsWith(':')) continue;
          const f: Frame = { event: 'message', data: {} };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) f.event = line.slice(6).trim();
            else if (line.startsWith('data:')) f.data = JSON.parse(line.slice(5).trim());
          }
          frames.push(f);
        }
      }
    } catch {
      // Cancelled with a read in flight; what was collected still stands.
    }
  })();
  return { frames, stop: () => void reader.cancel() };
}

/** The frames on a stream that came from one board's task channel. */
const taskFramesFor = (frames: Frame[], title: string) =>
  frames.filter((f) => f.event.startsWith('task.') && JSON.stringify(f.data).includes(title));

describe('leaving a board, and removing an agent from one', () => {
  let ws = '';
  let guestAttachedAt = 0;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-agent-leave-'));
    boot();
    const r = await call('POST', '/workspaces', { name: 'Harborlight board' });
    ws = (r.body.workspace as { id: string }).id;
    // The first attach claims the empty seat, so the lead goes first and the
    // guest is attached without it.
    await join_(ws, LEAD);
    guestAttachedAt = await join_(ws, GUEST);
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('takes the agent off with the verb, and a restart neither re-attaches nor re-watches it', async () => {
    expect(await agentsOn(ws)).toEqual([LEAD.id, GUEST.id]);
    const left = await leave(ws, GUEST);
    expect(left.result).toMatchObject({ workspaceId: ws, agentId: GUEST.id, detached: true });
    expect(left.detached).toEqual([ws]);
    expect(left.unwatched).toEqual([`ws:${ws}`]);
    expect(await agentsOn(ws)).toEqual([LEAD.id]);
    expect(await watchKeys(GUEST)).toEqual([]);

    const back = await restoreAs(GUEST);
    expect(back).toEqual({ wired: [], attachPosts: [] });
    expect(await agentsOn(ws)).toEqual([LEAD.id]);
  });

  it('after leaving, no frame from the board reaches the agent, on its open stream or a new one', async () => {
    const guestOpen = await listenAs(GUEST);
    const lead = await listenAs(LEAD);
    await leave(ws, GUEST);
    const guestNew = await listenAs(GUEST);
    const title = 'Harborlight posts the harbour notice';
    await call('POST', `/workspaces/${ws}/tasks/batch`, {
      tasks: [{ title, body: 'Fixture.' }],
      author: { ...LEAD, color: '#000000', kind: 'known' },
    });
    // The lead's copy is the positive control: the frame was sent.
    await waitFor(() => taskFramesFor(lead.frames, title).length > 0);
    // Past the lead's frame, the guest's copies would have arrived too: the
    // fan-out writes every stream in one pass.
    expect(taskFramesFor(guestOpen.frames, title)).toEqual([]);
    expect(taskFramesFor(guestNew.frames, title)).toEqual([]);
    for (const s of [guestOpen, lead, guestNew]) s.stop();
  });

  it('POSITIVE CONTROL: a guest that has not left does hear the board', async () => {
    const guest = await listenAs(GUEST);
    const title = 'Riverbend hears the harbour notice';
    await call('POST', `/workspaces/${ws}/tasks/batch`, {
      tasks: [{ title, body: 'Fixture.' }],
      author: { ...LEAD, color: '#000000', kind: 'known' },
    });
    await waitFor(() => taskFramesFor(guest.frames, title).length > 0);
    guest.stop();
  });

  it('answers a second leave as already gone, not as a failure', async () => {
    await leave(ws, GUEST);
    const again = await leave(ws, GUEST);
    expect(again.result).toMatchObject({ detached: false });
  });

  it('keeps an agent Bryan removed off the board after its restart', async () => {
    // The board's control is this DELETE, made for somebody else.
    const removed = await call('DELETE', `/workspaces/${ws}/agents/${GUEST.id}`);
    expect(removed).toEqual({ status: 200, body: { ok: true, unwatched: true } });
    expect(await agentsOn(ws)).toEqual([LEAD.id]);

    expect(await restoreAs(GUEST)).toEqual({ wired: [], attachPosts: [] });
    expect(await agentsOn(ws)).toEqual([LEAD.id]);
  });

  it('POSITIVE CONTROL: without the removal, the same restore does bring the guest back', async () => {
    // Freshly attached and worked nowhere — but the attach itself is this
    // run's, so make it do something here first, as a working guest would.
    await pastAttach(guestAttachedAt);
    await call('POST', `/workspaces/${ws}/tasks/batch`, {
      tasks: [{ title: 'Riverbend checks the ferry timetable', body: 'Fixture.' }],
      author: { ...GUEST, color: '#000000', kind: 'known' },
    });
    const back = await restoreAs(GUEST);
    expect(back.wired).toEqual([`ws:${ws}`]);
    expect(back.attachPosts).toEqual([ws]);
  });

  it('after a server restart, re-attaches the lead and a worker but not a dormant guest', async () => {
    await pastAttach(await join_(ws, WORKER));
    const filed = await call('POST', `/workspaces/${ws}/tasks/batch`, {
      tasks: [{ title: 'Saltmarsh drafts the tide table', body: 'Fixture.' }],
      author: { ...WORKER, color: '#000000', kind: 'known' },
    });
    expect(filed.status).toBe(200);
    await server.stop();
    boot();

    const guest = await restoreAs(GUEST);
    const worker = await restoreAs(WORKER);
    const lead = await restoreAs(LEAD);
    // The guest's watch still comes back — it asked for the board's events —
    // but its row is not revived.
    expect(guest).toEqual({ wired: [`ws:${ws}`], attachPosts: [] });
    expect(worker.attachPosts).toEqual([ws]);
    expect(lead.attachPosts).toEqual([ws]);
  });
});
