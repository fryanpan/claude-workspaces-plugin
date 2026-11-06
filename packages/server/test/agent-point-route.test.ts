/**
 * `POST /workspaces/<ws>/point`: an agent points its followers at a page of
 * the board, a thread, or a place in a doc or mock, and writes nothing.
 *
 * Real server, port 0, a temp data dir. The room is read the way a page
 * reads it: the server's own awareness on the board doc, through
 * `parseAgentSpots`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SPOTS_FIELD, parseAgentSpots } from '@claude-workspaces/core/workspace-presence';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceDocId } from '../src/task-projection.ts';
import { agentStream } from './agent-voice-stream.ts';
import { waitFor } from './wait-for.ts';

const AGENT = { agentId: 'agent-house-lead', agentName: 'Harborlight' };
const FIRST_PERSON = { id: 'known-first-person', name: 'Alice', kind: 'known' };

describe('an agent pointing its followers', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws = '';
  let other = '';
  let docId = '';
  let mockId = '';
  let taskId = '';
  let stream: Awaited<ReturnType<typeof agentStream>>;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const point = (body: Record<string, unknown>) =>
    post(`/workspaces/${ws}/point`, { ...AGENT, ...body });
  /** Where the room says the agent points, once the board doc is open. */
  const spot = () => {
    const aw = handle.docStore.peek(workspaceDocId(ws))?.peekAwareness();
    return parseAgentSpots(aw?.getLocalState()?.[AGENT_SPOTS_FIELD]).get(AGENT.agentId);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-agent-point-'));
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    base = `http://127.0.0.1:${handle.port}`;
    const made = async (name: string) =>
      (
        (await (await post('/workspaces', { name, author: FIRST_PERSON })).json()) as {
          workspace: { id: string };
        }
      ).workspace.id;
    ws = await made('Harborlight');
    other = await made('Riverbend');
    handle.tasks.attachAgent(ws, { ...AGENT, runtime: 'claude-code-local' });
    stream = await agentStream(base, ws, AGENT.agentId);
    const file = join(dataDir, 'quay.md');
    writeFileSync(file, '# Quay\n\n## Tides\n\nThe quay opens at dawn.\n');
    docId = (
      (await (
        await post(`/workspaces/${ws}/docs`, { docId: 'quay', type: 'markdown', sourceUrl: file })
      ).json()) as { docId: string }
    ).docId;
    const mockFile = join(dataDir, 'tide-mock.html');
    writeFileSync(mockFile, '<!doctype html><title>Tides</title><p>High water</p>');
    mockId = (
      (await (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'tide-mock',
          type: 'mockup',
          sourceUrl: mockFile,
        })
      ).json()) as { docId: string }
    ).docId;
    taskId = (
      (await (
        await post(`/workspaces/${ws}/tasks`, {
          title: 'Harborlight tide table',
          author: FIRST_PERSON,
        })
      ).json()) as { task: { id: string } }
    ).task.id;
    // The board doc's room is what a page joins; open it, as a page would.
    expect(handle.docStore.get(workspaceDocId(ws))?.awareness).toBeDefined();
  });

  afterAll(async () => {
    stream.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('opens an app at its door, as a framed page', async () => {
    const appFile = join(dataDir, 'tide-app.html');
    writeFileSync(appFile, '<!doctype html><title>Tides</title>');
    const made = await post(`/workspaces/${ws}/apps`, {
      docId: 'tide-app',
      origin: 'http://127.0.0.1:8796/',
      title: 'Tide app',
    });
    expect(made.status, await made.clone().text()).toBe(200);
    const { docId: appId } = (await made.json()) as { docId: string };
    expect((await point({ docId: appId, scroll: 0.5 })).status).toBe(200);
    const door = `/workspaces/${ws}/apps/${appId}/`;
    await waitFor(() => spot()?.path === door, { describe: 'the room points at the door' });
    expect(spot()).toMatchObject({ surface: 'mock', docId: appId, scroll: 0.5 });
  });

  it('points at a board tab, a review item, a task panel and its thread', async () => {
    for (const [body, path] of [
      [{ path: 'home' }, `/workspaces/${ws}/home`],
      [{ path: 'library' }, `/workspaces/${ws}/library`],
      [
        { path: 'home?item=task-review:t-1:ri-1' },
        `/workspaces/${ws}/home?item=task-review%3At-1%3Ari-1`,
      ],
      [{ taskId }, `/workspaces/${ws}?task=${taskId}`],
      [{ taskId, threadId: 'th-1' }, `/workspaces/${ws}?task=${taskId}&thread=th-1`],
      [{ path: '/review' }, '/review'],
      [{ path: '/' }, '/'],
      // `/workspaces` answers JSON, so the list's own address is the root.
      [{ path: '/workspaces' }, '/'],
    ] as const) {
      const res = await point(body);
      expect(res.status, JSON.stringify(body)).toBe(200);
      await waitFor(() => spot()?.path === path, { describe: `the room points at ${path}` });
      expect(spot()).toMatchObject({ surface: 'board', name: 'Harborlight' });
    }
  });

  it('points at a phrase, a block or a scroll position in a doc, and at a mock', async () => {
    expect((await point({ docId, quote: 'opens at dawn' })).status).toBe(200);
    await waitFor(() => spot()?.quote === 'opens at dawn', { describe: 'the phrase' });
    expect(spot()).toMatchObject({ surface: 'doc', docId });
    expect((await point({ docId, scroll: 0.75 })).status).toBe(200);
    await waitFor(() => spot()?.scroll === 0.75, { describe: 'the scroll' });
    expect((await point({ docId: mockId, quote: 'High water' })).status).toBe(200);
    await waitFor(() => spot()?.surface === 'mock', { describe: 'the mock' });
    expect(spot()).toMatchObject({ docId: mockId, quote: 'High water' });
  });

  it('writes nothing to the doc it points at', async () => {
    // The doc as a reader sees it, less `lastActivityAt`: that is the
    // `.ydoc`'s mtime, which the doc's own first persist after this file's
    // earlier reads can still move. It moved 29ms once, with no point made.
    const read = async () => {
      const res = await fetch(`${base}/workspaces/${ws}/docs/${docId}?format=json`);
      const doc = (await res.json()) as { meta: Record<string, unknown> };
      const { lastActivityAt: _mtime, ...meta } = doc.meta;
      return JSON.stringify({ ...doc, meta });
    };
    const before = await read();
    const threads = await (await fetch(`${base}/workspaces/${ws}/docs/${docId}/threads`)).text();
    await point({ docId, quote: 'The quay' });
    await waitFor(() => spot()?.quote === 'The quay', { describe: 'the point' });
    expect(await read()).toBe(before);
    expect(await (await fetch(`${base}/workspaces/${ws}/docs/${docId}/threads`)).text()).toBe(
      threads,
    );
  });

  it('refuses what is not on this board, and an agent not attached to it', async () => {
    const refused = async (body: Record<string, unknown>, status: number, to = ws) => {
      const res = await post(`/workspaces/${to}/point`, { agentId: AGENT.agentId, ...body });
      expect(res.status, JSON.stringify(body)).toBe(status);
    };
    await refused({}, 400);
    await refused({ path: '//evil.example/x' }, 400);
    await refused({ path: '/workspaces/other/home' }, 400);
    await refused({ path: '../settings' }, 400);
    await refused({ scroll: 2, docId }, 400);
    await refused({ threadId: 'th-1' }, 400);
    await refused({ docId: 'nope-not-here' }, 404);
    await refused({ taskId: 't-nope' }, 404);
    await refused({ path: 'home' }, 403, other);
    const res = await post(`/workspaces/${ws}/point`, { agentId: 'bad id!', path: 'home' });
    expect(res.status).toBe(400);
  });
});
