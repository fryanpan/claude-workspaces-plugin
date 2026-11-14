/**
 * The server sets every presence name, over real `/y` sockets.
 *
 * A page puts whatever it likes in its awareness `user`. What every other
 * page hears is the name the server proved for that socket: the signed-in
 * person, or a `guest-` id derived from the browser's own id for a socket
 * that proved nobody. No page may write presence for the server's own client
 * id, which carries where the agents are pointing, nor the fields only the
 * server writes. A client id moves to a new socket only when its state is
 * gone or the new socket is the same person.
 *
 * Real server, port 0, a temp data dir, invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_SPOTS_FIELD,
  DIRECTIVE_FIELD,
  PERSON_SPOT_FIELD,
} from '@claude-workspaces/core/workspace-presence';
import * as encoding from 'lib0/encoding';
import { removeAwarenessStates } from 'y-protocols/awareness';
import { type ServerHandle, createServer } from '../src/server.ts';
import { sanitizeVisitorAuthor } from '../src/share/visitor-identity.ts';
import { type RoomPage, agentFrames, joinRoom } from './room-page.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

process.env.CW_LOG_LOGIN_CODES = '1';
const codes: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  const m = args
    .map(String)
    .join(' ')
    .match(/login code for \S+: (\d{6})/);
  if (m?.[1]) codes.push(m[1]);
  originalLog(...(args as []));
};

const AGENT = { agentId: 'agent-harborlight', agentName: 'Harborlight' };

type Heard = { user?: { id?: string; name?: string } } & Record<string, unknown>;

/** The state `reader` hears for `from`'s client id, or null. */
function stateOf(reader: RoomPage, from: RoomPage | number): Heard | null {
  const id = typeof from === 'number' ? from : from.ydoc.clientID;
  return (reader.awareness.getStates().get(id) as Heard | undefined) ?? null;
}

/** An awareness frame for one client id at one clock, built by hand. */
function forgedFrame(clientId: number, clock: number, state: unknown): Uint8Array {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, 1);
  encoding.writeVarUint(inner, clientId);
  encoding.writeVarUint(inner, clock);
  encoding.writeVarString(inner, JSON.stringify(state));
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint8Array(enc, encoding.toUint8Array(inner));
  return encoding.toUint8Array(enc);
}

describe('presence names the server set', () => {
  let handle: ServerHandle;
  let dataDir = '';
  let base = '';
  let ws = '';
  let cookie = '';
  const closers: Array<{ close(): void }> = [];

  const room = () => `ws://127.0.0.1:${handle.port}/workspaces/${ws}/y?type=workspace&presence=1`;
  const open = async (
    headers: Record<string, string> = {},
    clientID?: number,
  ): Promise<RoomPage> => {
    const page = joinRoom(room(), base, headers, clientID);
    closers.push(page);
    await page.ready;
    return page;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-presence-stamp-'));
    handle = createServer({
      port: 0,
      dataDir,
      emailCodeSignIn: true,
      requireSignInToWrite: true,
    } as Parameters<typeof createServer>[0]);
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base);
    const browser = {
      'content-type': 'application/json',
      origin: base,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
    };
    const before = codes.length;
    const started = await fetch(`${base}/api/auth/start`, {
      method: 'POST',
      headers: browser,
      body: JSON.stringify({ email: 'alice@example.com' }),
    });
    expect(started.status).toBe(200);
    expect(codes.length).toBe(before + 1);
    const verified = await fetch(`${base}/api/auth/verify`, {
      method: 'POST',
      headers: browser,
      body: JSON.stringify({ email: 'alice@example.com', code: codes[codes.length - 1] }),
    });
    expect(verified.status).toBe(200);
    cookie = (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  afterAll(async () => {
    for (const c of closers.splice(0)) c.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    console.log = originalLog;
  });

  it("Alice's page announcing the name Bob shows as Alice to a second page", async () => {
    const alice = await open({ cookie });
    const watcher = await open();
    alice.awareness.setLocalState({
      user: { id: 'known-bob', name: 'Bob', color: '#336699' },
      surface: 'board',
      [PERSON_SPOT_FIELD]: { surface: 'board' },
    });
    const heard = await waitFor(() => stateOf(watcher, alice)?.user ?? null, {
      describe: "Alice's presence on the second page",
    });
    expect(heard.name).not.toBe('Bob');
    expect(heard.id).not.toBe('known-bob');
    expect(heard.id).toMatch(/^user-/);
    alice.close();
    watcher.close();
  });

  it("a socket that proved nobody is a guest named from its browser's id, the same on every socket", async () => {
    const signedIn = await open({ cookie });
    const tabA = await open();
    const tabB = await open();
    for (const tab of [tabA, tabB]) {
      tab.awareness.setLocalState({
        user: { id: 'anon-riverbend1', name: 'Bob', color: '#336699' },
        surface: 'board',
      });
    }
    const a = await waitFor(() => stateOf(signedIn, tabA)?.user ?? null, {
      describe: "the first tab's presence",
    });
    const b = await waitFor(() => stateOf(signedIn, tabB)?.user ?? null, {
      describe: "the second tab's presence",
    });
    expect(a.id).toBe(sanitizeVisitorAuthor({ id: 'anon-riverbend1' }, { shareKey: 'local' }).id);
    expect(b.id).toBe(a.id);
    expect(a.id).not.toBe('anon-riverbend1');
    for (const p of [signedIn, tabA, tabB]) p.close();
  });

  it("a guest may not show a member's name", async () => {
    const alice = await open({ cookie });
    const watcher = await open({ cookie });
    alice.awareness.setLocalState({ surface: 'board' });
    const aliceName = await waitFor(() => stateOf(watcher, alice)?.user?.name ?? null, {
      describe: "Alice's name on another page",
    });
    const guest = await open();
    guest.awareness.setLocalState({
      user: { id: 'anon-saltmarsh', name: aliceName },
      surface: 'board',
    });
    const heard = await waitFor(() => stateOf(watcher, guest)?.user ?? null, {
      describe: "the guest's presence",
    });
    expect(heard.id).toMatch(/^guest-/);
    expect(heard.name).not.toBe(aliceName);
    for (const p of [alice, watcher, guest]) p.close();
  });

  it('strips the fields only the server writes from a page state', async () => {
    const alice = await open({ cookie });
    const watcher = await open();
    alice.awareness.setLocalState({
      surface: 'board',
      marker: 'forged-fields',
      [AGENT_SPOTS_FIELD]: { 'agent-harborlight': { seq: 1, spot: { surface: 'board' } } },
      [DIRECTIVE_FIELD]: { to: watcher.ydoc.clientID, seq: 1e12, spot: { surface: 'board' } },
    });
    const heard = await waitFor(
      () => (stateOf(watcher, alice)?.marker === 'forged-fields' ? stateOf(watcher, alice) : null),
      { describe: "Alice's state on the second page" },
    );
    expect(heard[AGENT_SPOTS_FIELD]).toBeUndefined();
    expect(heard[DIRECTIVE_FIELD]).toBeUndefined();
    alice.close();
    watcher.close();
  });

  it('a reconnect by the same person takes over its client id while the old socket is still open', async () => {
    const watcher = await open();
    const first = await open({ cookie });
    first.awareness.setLocalState({ surface: 'board', marker: 'first' });
    await waitFor(() => stateOf(watcher, first)?.marker === 'first', {
      describe: 'the first socket state',
    });
    // The old socket stays open, as a half-open one does after a network drop.
    const second = await open({ cookie }, first.ydoc.clientID);
    second.awareness.setLocalState({ surface: 'board', marker: 'second' });
    await waitFor(() => stateOf(watcher, first.ydoc.clientID)?.marker === 'second', {
      describe: 'the reconnected socket state, under the same client id',
    });
    for (const p of [watcher, first, second]) p.close();
  });

  it('another person may not take a client id whose state is live, and may once it is swept', async () => {
    const watcher = await open();
    const owner = await open({ cookie });
    owner.awareness.setLocalState({ surface: 'board', marker: 'owner' });
    await waitFor(() => stateOf(watcher, owner)?.marker === 'owner', {
      describe: "the holder's state",
    });
    const id = owner.ydoc.clientID;
    const squatter = await open({}, id);
    const serverAwareness = handle.docStore.get(`ws:${ws}`)?.awareness;
    if (!serverAwareness) throw new Error('no board room doc');
    squatter.awareness.setLocalState({ surface: 'board', marker: 'squatter' });
    // Frames on one socket are handled in order: once this later entry, for a
    // client id nobody holds, has landed, the squatter's frame has been too.
    const sentinel = id + 1_000_003;
    squatter.send(forgedFrame(sentinel, 1, { surface: 'board', marker: 'sentinel' }));
    await waitFor(
      () => (serverAwareness.getStates().get(sentinel) as Heard | undefined)?.marker === 'sentinel',
      { describe: "the squatter's later frame" },
    );
    expect((serverAwareness.getStates().get(id) as Heard | undefined)?.marker).toBe('owner');
    // The outdated sweep removes the holder's state; the id is free.
    removeAwarenessStates(serverAwareness, [id], 'timeout');
    squatter.awareness.setLocalState({ surface: 'board', marker: 'after-sweep' });
    await waitFor(() => stateOf(watcher, id)?.marker === 'after-sweep', {
      describe: 'the new socket state once the old one was swept',
    });
    for (const p of [watcher, owner, squatter]) p.close();
  });

  it("a page cannot overwrite the server's own presence, where agents are shown pointing", async () => {
    handle.tasks.attachAgent(ws, { ...AGENT, runtime: 'claude-code-local' });
    const stream = await agentFrames(base, ws, AGENT.agentId);
    closers.push(stream);
    const docMade = await fetch(`${base}/workspaces/${ws}/point`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...AGENT, path: 'home' }),
    });
    expect(docMade.status, await docMade.clone().text()).toBe(200);
    const serverAwareness = handle.docStore.get(`ws:${ws}`)?.awareness;
    if (!serverAwareness) throw new Error('no board room doc');
    await waitFor(() => serverAwareness.getLocalState()?.[AGENT_SPOTS_FIELD] !== undefined, {
      describe: "the agent's point in the server's presence",
    });
    const attacker = await open({ cookie });
    const serverId = serverAwareness.clientID;
    const clock = serverAwareness.meta.get(serverId)?.clock ?? 0;
    attacker.send(forgedFrame(serverId, clock + 5, { forged: true }));
    // Frames are handled in order, so once the attacker's own state has
    // arrived the forged one before it has been handled too.
    attacker.awareness.setLocalState({ surface: 'board', marker: 'after-forgery' });
    await waitFor(
      () =>
        (serverAwareness.getStates().get(attacker.ydoc.clientID) as { marker?: string } | undefined)
          ?.marker === 'after-forgery',
      { describe: "the attacker's own state, sent after the forgery" },
    );
    const local = serverAwareness.getLocalState();
    expect(local?.forged).toBeUndefined();
    expect(local?.[AGENT_SPOTS_FIELD]).toBeDefined();
    attacker.close();
  });
});
