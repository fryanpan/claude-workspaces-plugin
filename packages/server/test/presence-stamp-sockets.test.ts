/**
 * The server sets every presence name, over real `/y` sockets.
 *
 * A page puts whatever it likes in its awareness `user`. What every other
 * page hears is the name the server proved for that socket: the signed-in
 * person, or `Guest …` for a read-only socket that proved nobody. And no page
 * may write presence for the server's own client id, which carries where the
 * agents are pointing.
 *
 * Real server, port 0, a temp data dir, invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SPOTS_FIELD, PERSON_SPOT_FIELD } from '@claude-workspaces/core/workspace-presence';
import * as encoding from 'lib0/encoding';
import { type ServerHandle, createServer } from '../src/server.ts';
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

/** The `user` of every state this page hears from another client. */
function usersHeardBy(page: RoomPage): Array<{ id?: string; name?: string }> {
  return [...page.awareness.getStates()]
    .filter(([id]) => id !== page.ydoc.clientID)
    .map(([, s]) => (s as { user?: { id?: string; name?: string } }).user)
    .filter((u): u is { id?: string; name?: string } => u !== undefined);
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
  const open = async (headers: Record<string, string> = {}): Promise<RoomPage> => {
    const page = joinRoom(room(), base, headers);
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
    const heard = await waitFor(
      () => usersHeardBy(watcher).find((u) => u.id !== undefined && u.id !== '') ?? null,
      { describe: "Alice's presence on the second page" },
    );
    expect(heard.name).not.toBe('Bob');
    expect(heard.id).not.toBe('known-bob');
    expect(heard.id).toMatch(/^user-/);
    alice.close();
    watcher.close();
  });

  it('a read-only socket that proved nobody shows as Guest, whatever it typed', async () => {
    const reader = await open();
    const signedIn = await open({ cookie });
    reader.awareness.setLocalState({
      user: { id: 'known-bob', name: 'Bob', color: '#336699' },
      surface: 'board',
    });
    const heard = await waitFor(
      () => usersHeardBy(signedIn).find((u) => typeof u.name === 'string') ?? null,
      { describe: "the reader's presence on the signed-in page" },
    );
    expect(heard.name).toMatch(/^Guest /);
    expect(heard.id).not.toBe('known-bob');
    reader.close();
    signedIn.close();
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
