/**
 * The workspace's presence room: where a person and an agent are, heard by
 * every page of the board at once.
 *
 * A person is one spot: a doc page joins the board's room on a
 * presence-only socket, announces its spot, and a page already open on the
 * board hears it — without the doc page ever being sent the board's content.
 *
 * An agent is the spot it points at by a verb: a comment it writes, or a
 * whiteboard `point`. Its edits draw nothing. `seq` grows by one per point,
 * so "an edit moved nothing" is read as the NEXT point arriving at exactly
 * one more than the last, rather than as a silence.
 *
 * Real server, real `/y` sockets, port 0, a temp data dir, invented names.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_SPOTS_FIELD,
  type AgentSpot,
  PERSON_SPOT_FIELD,
  parseAgentSpots,
} from '@claude-workspaces/core/workspace-presence';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const AGENT = { id: 'agent-harborlight', name: 'Harborlight', kind: 'known', color: '#2e7dd7' };
const PERSON = { id: 'known-riverbend', name: 'Riverbend', kind: 'known', color: '#c0392b' };

/** One page's socket: syncs, applies what it hears, announces its state. */
function joinRoom(url: string, origin: string) {
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  const ws = new WebSocket(url, { headers: { origin } } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let synced: () => void = () => {};
  const ready = new Promise<void>((r) => {
    synced = r;
  });
  awareness.on('update', (_: unknown, from: unknown) => {
    if (from !== 'local' || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [ydoc.clientID]),
    );
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    const kind = decoding.readVarUint(dec);
    if (kind === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
      return;
    }
    if (kind !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (type === syncProtocol.messageYjsSyncStep2) synced();
  });
  return { ydoc, awareness, ready, close: () => ws.close() };
}

/** The stream an agent's MCP child holds for its session; an agent without
 *  one is absent, and the room draws nobody absent. */
async function agentStream(base: string, ws: string, agentId: string) {
  const abort = new AbortController();
  const res = await fetch(
    `${base}/workspaces/${ws}/events:stream?agentId=${encodeURIComponent(agentId)}`,
    { headers: { accept: 'text/event-stream' }, signal: abort.signal },
  );
  expect(res.status).toBe(200);
  return { close: () => abort.abort() };
}

/** Every state this page hears from somebody else. */
function others(page: ReturnType<typeof joinRoom>): Array<Record<string, unknown>> {
  return [...page.awareness.getStates()]
    .filter(([id]) => id !== page.ydoc.clientID)
    .map(([, s]) => s as Record<string, unknown>);
}

/** Where the server says `agentId` is pointing, as this page hears it. */
function agentSpot(page: ReturnType<typeof joinRoom>, agentId: string): AgentSpot | undefined {
  for (const s of others(page)) {
    const hit = parseAgentSpots(s[AGENT_SPOTS_FIELD]).get(agentId);
    if (hit) return hit;
  }
  return undefined;
}

describe('the workspace presence room', () => {
  let handle: ServerHandle | null = null;
  let dataDir = '';
  const closers: Array<{ close: () => void }> = [];

  afterEach(async () => {
    for (const c of closers.splice(0)) c.close();
    await handle?.stop();
    handle = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function boot() {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-presence-room-'));
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://127.0.0.1:${handle.port}`;
    const ws = await seedBoard(base);
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const room = (presence: boolean) =>
      `ws://127.0.0.1:${handle?.port}/workspaces/${ws}/y?type=workspace${presence ? '&presence=1' : ''}`;
    const file = join(dataDir, 'harbour.md');
    writeFileSync(file, '# Harbour\n\nThe quay opens at dawn.\n');
    const made = await post(`/workspaces/${ws}/docs`, {
      docId: 'harbour',
      type: 'markdown',
      sourceUrl: file,
    });
    expect(made.status).toBe(200);
    // The server names the doc; `harbour` stays an address for it.
    const { docId } = (await made.json()) as { docId: string };
    return { base, ws, post, room, docId };
  }

  it("a doc page's person reaches an open board page, and the doc page is sent no board content", async () => {
    const { base, ws, post, room } = await boot();
    const board = joinRoom(room(false), base);
    const docPage = joinRoom(room(true), base);
    closers.push(board, docPage);
    await Promise.all([board.ready, docPage.ready]);

    docPage.awareness.setLocalState({
      user: { id: PERSON.id, name: PERSON.name, color: PERSON.color },
      surface: 'doc',
      docId: 'harbour',
      [PERSON_SPOT_FIELD]: { surface: 'doc', docId: 'harbour', blockId: 'b-quay' },
      lastActive: 1,
    });
    await waitFor(
      () =>
        others(board).some(
          (s) => (s[PERSON_SPOT_FIELD] as { blockId?: string } | undefined)?.blockId === 'b-quay',
        ),
      { describe: "the doc page's spot on the board page" },
    );

    // A board write reaches the board page and never the presence-only one.
    expect(
      (await post(`/workspaces/${ws}/tasks`, { title: 'Paint the quay', author: PERSON })).status,
    ).toBe(200);
    await waitFor(() => board.ydoc.share.size > 0 && Y.encodeStateAsUpdate(board.ydoc).length > 2, {
      describe: 'the task on the board page',
    });
    // The board page hears the doc page; the doc page heard the board page's
    // join too. Its ydoc is exactly an empty doc.
    expect(Y.encodeStateAsUpdate(docPage.ydoc)).toEqual(Y.encodeStateAsUpdate(new Y.Doc()));
  });

  it("an agent's comment is its spot, its edit draws nothing, and its whiteboard point moves it", async () => {
    const { base, ws, post, room, docId } = await boot();
    const follower = joinRoom(room(true), base);
    closers.push(follower, await agentStream(base, ws, AGENT.id));
    await follower.ready;

    const created = await post(`/workspaces/${ws}/docs/harbour/threads/by_find`, {
      author: AGENT,
      text: 'This is the line I mean.',
      find: 'quay opens',
    });
    expect(created.status).toBe(200);
    const { thread } = (await created.json()) as { thread: { id: string } };
    await waitFor(() => agentSpot(follower, AGENT.id)?.threadId === thread.id, {
      describe: "the agent's comment as its spot",
    });
    const atComment = agentSpot(follower, AGENT.id);
    expect(atComment).toMatchObject({ surface: 'doc', docId, name: 'Harborlight' });

    // An edit elsewhere in the doc: written, and not a point.
    const edit = await post(`/workspaces/${ws}/docs/harbour/find_and_replace`, {
      author: AGENT,
      find: 'dawn',
      replace: 'first light',
    });
    expect(edit.status).toBe(200);
    // A person's reply on the agent's thread is not the agent pointing either.
    expect(
      (
        await post(`/workspaces/${ws}/docs/harbour/threads/${thread.id}/comments`, {
          author: PERSON,
          text: 'Agreed.',
        })
      ).status,
    ).toBe(200);
    // A drawing without `point` is an edit too.
    const board = await post(`/workspaces/${ws}/whiteboards`, { title: 'Quay plan' });
    const { docId: wb } = (await board.json()) as { docId: string };
    const draw = (body: Record<string, unknown>) =>
      post(`/workspaces/${ws}/docs/${wb}/whiteboard`, { author: AGENT, ...body });
    expect((await draw({ shapes: [{ id: 'q', kind: 'box', x: 0, y: 0 }] })).status).toBe(200);

    // The next point lands one past the comment: nothing in between moved it.
    expect((await draw({ shapes: [], point: { x: 320, y: 140 } })).status).toBe(200);
    await waitFor(() => agentSpot(follower, AGENT.id)?.surface === 'whiteboard', {
      describe: "the agent's whiteboard point as its spot",
    });
    expect(agentSpot(follower, AGENT.id)).toMatchObject({
      surface: 'whiteboard',
      docId: wb,
      x: 320,
      y: 140,
      seq: (atComment?.seq ?? 0) + 1,
    });
  });

  it('a page that opens the room after the agent pointed still finds it, until the agent leaves', async () => {
    const { base, post, ws, room } = await boot();
    const stream = await agentStream(base, ws, AGENT.id);
    closers.push(stream);
    // Nobody is in the board's room when the agent comments.
    const created = await post(`/workspaces/${ws}/docs/harbour/threads/by_find`, {
      author: AGENT,
      text: 'Start here.',
      find: 'quay opens',
    });
    expect(created.status).toBe(200);
    const { thread } = (await created.json()) as { thread: { id: string } };

    const late = joinRoom(room(true), base);
    closers.push(late);
    await late.ready;
    await waitFor(() => agentSpot(late, AGENT.id)?.threadId === thread.id, {
      describe: "the agent's earlier comment, heard by a page that joined after it",
    });

    // The agent's session ends: its spot goes with it.
    stream.close();
    await waitFor(() => agentSpot(late, AGENT.id) === undefined, {
      describe: "the agent's spot gone once its stream closed",
    });
  });
});
