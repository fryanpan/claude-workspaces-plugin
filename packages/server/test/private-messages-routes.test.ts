/**
 * A person's private message reaches only their own linked lead agent, and
 * only that person reads the conversation.
 *
 * Alice and her agent A1, Bob and his agent B1, and a board lead L that is
 * neither. Real server, port 0, a temp data dir; people prove themselves
 * with the session cookie the server's own sign-in sets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commentQueuePath } from '../src/agent-comment-queue.ts';
import { agentTokenKey, mintAgentToken } from '../src/auth/agent-token.ts';
import { mintBoardWidgetToken, widgetTokenKey } from '../src/auth/widget-token.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import { type Frame, listenFrames } from './doc-activity-stall-harness.ts';
import { startShareProofServer } from './share-proof-harness.ts';
import { type SignedInPerson, signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const A1 = 'agent-harborlight-a1';
const B1 = 'agent-riverbend-b1';
const LEAD = 'agent-saltmarsh-lead';
const SSE = { accept: 'text/event-stream' };

describe('private messages between a person and their own agent', () => {
  let handle: ServerHandle;
  let dataDir = '';
  let base = '';
  let ws = '';
  let alice: SignedInPerson;
  let bob: SignedInPerson;
  let saltmarsh: SignedInPerson;
  const at1 = (agentId: string) => mintAgentToken(agentId, agentTokenKey(loadCookieKey(dataDir)));
  const streams: Array<ReturnType<typeof listenFrames>> = [];
  const frames: Record<string, Frame[]> = {};

  const send = (who: SignedInPerson, body: unknown) =>
    fetch(`${base}/api/me/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...who.headers },
      body: JSON.stringify(body),
    });
  const read = async (who: SignedInPerson, query = '') => {
    const res = await fetch(`${base}/api/me/messages${query}`, { headers: who.headers });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      agentId: string;
      messages: Array<{ from: string; text: string; personId: string }>;
    };
  };
  const reply = (agentId: string, personId: string, text: string, token = at1(agentId)) =>
    fetch(`${base}/api/agents/${agentId}/messages/${encodeURIComponent(personId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
  const open = async (key: string, path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { headers: { ...SSE, ...headers } });
    expect(res.status).toBe(200);
    const l = listenFrames(res);
    streams.push(l);
    frames[key] = l.frames;
  };
  const saw = (key: string, text: string) =>
    (frames[key] ?? []).some((f) => f.event === 'private.message' && f.data?.text === text);

  async function link(who: SignedInPerson, agentId: string) {
    const named = await fetch(`${base}/api/auth/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...who.headers },
      body: JSON.stringify({ leadAgentId: agentId }),
    });
    expect(named.status).toBe(200);
    const confirmed = await fetch(`${base}/api/agents/${agentId}/person`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${at1(agentId)}` },
      body: JSON.stringify({ personId: who.user.id }),
    });
    expect(await confirmed.json()).toMatchObject({ state: 'linked' });
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-private-routes-'));
    handle = createServer({ port: 0, dataDir } as Parameters<typeof createServer>[0]);
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base);
    for (const [agentId, agentName] of [
      [A1, 'Harborlight'],
      [B1, 'Riverbend'],
      [LEAD, 'Saltmarsh Lead'],
    ] as const) {
      handle.tasks.attachAgent(ws, { agentId, agentName, runtime: 'claude-code-local' });
      handle.identities.upsertAgent(agentId, agentName);
    }
    handle.tasks.setLeadAgent(ws, LEAD, {
      actor: { id: 'known-owner', name: 'Owner', kind: 'known' },
    });
    alice = signedInPerson(handle, dataDir, base, {
      email: 'alice@harborlight.example',
      name: 'Alice',
    });
    bob = signedInPerson(handle, dataDir, base, { email: 'bob@riverbend.example', name: 'Bob' });
    saltmarsh = signedInPerson(handle, dataDir, base, {
      email: 'saltmarsh@harborlight.example',
      name: 'Saltmarsh',
    });
    await link(alice, A1);
    await link(bob, B1);
    for (const agentId of [A1, B1, LEAD]) {
      await open(agentId, `/workspaces/${ws}/events:stream?agentId=${agentId}`);
    }
    await open('page', `/workspaces/${ws}/events:stream`);
    await open('alice', `/workspaces/${ws}/me/events:stream`, alice.headers);
    await open('bob', `/workspaces/${ws}/me/events:stream`, bob.headers);
  });

  afterAll(async () => {
    for (const l of streams) await l.stop();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("Alice's message reaches A1 alone: no row and no frame for B1 or the lead", async () => {
    const sent = await send(alice, { text: 'A1, private one', agentId: B1 });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ agentId: A1, message: { from: 'person' } });
    // Bob's message is the sentinel: once B1 has it, Alice's is not coming.
    expect((await send(bob, { text: 'B1, private two' })).status).toBe(200);

    await waitFor(() => saw(A1, 'A1, private one'), { describe: "Alice's message on A1" });
    await waitFor(() => saw(B1, 'B1, private two'), { describe: "Bob's message on B1" });
    expect(saw(B1, 'A1, private one')).toBe(false);
    expect(saw(A1, 'B1, private two')).toBe(false);
    expect(saw(LEAD, 'A1, private one')).toBe(false);
    expect(saw('page', 'A1, private one')).toBe(false);
    expect(saw('bob', 'A1, private one')).toBe(false);

    const rows = handle.tasks
      .listQueuedComments(ws)
      .filter((r) => r.event === 'private.message' && r.text === 'A1, private one');
    expect(rows.map((r) => r.agentId)).toEqual([A1]);
    // The row holds the message's words, so its file is the owner's alone.
    expect(statSync(commentQueuePath(dataDir, ws)).mode & 0o777).toBe(0o600);
  });

  it("Bob's read never returns Alice's log, whatever the query names", async () => {
    const mine = await read(bob, `?personId=${encodeURIComponent(alice.user.id)}&agentId=${A1}`);
    expect(mine.agentId).toBe(B1);
    expect(mine.messages.map((m) => m.text)).toEqual(['B1, private two']);
    expect(mine.messages.every((m) => m.personId === bob.user.id)).toBe(true);
  });

  it("A1's reply reaches Alice's open stream and no other", async () => {
    expect((await reply(A1, alice.user.id, 'Got it, Alice')).status).toBe(200);
    expect((await reply(B1, bob.user.id, 'Got it, Bob')).status).toBe(200);
    await waitFor(() => saw('alice', 'Got it, Alice'), { describe: 'the reply on Alice’s stream' });
    await waitFor(() => saw('bob', 'Got it, Bob'), { describe: 'the sentinel on Bob’s stream' });
    expect(saw('bob', 'Got it, Alice')).toBe(false);
    expect(saw('page', 'Got it, Alice')).toBe(false);
    expect(saw(LEAD, 'Got it, Alice')).toBe(false);
    const log = await read(alice);
    expect(log.messages.map((m) => [m.from, m.text])).toEqual([
      ['person', 'A1, private one'],
      ['agent', 'Got it, Alice'],
    ]);
  });

  it("refuses B1 writing to Alice, an agent call without its own token, and an unlinked person's send", async () => {
    expect((await reply(B1, alice.user.id, 'Hello Alice')).status).toBe(403);
    expect((await reply(A1, alice.user.id, 'Forged', at1(B1))).status).toBe(403);
    const unlinked = await send(saltmarsh, { text: 'anyone?' });
    expect(unlinked.status).toBe(409);
    expect(await unlinked.json()).toMatchObject({ error: 'no_lead_agent' });
    expect((await read(alice)).messages.map((m) => m.text)).not.toContain('Hello Alice');
  });

  it('refuses a request that proved nobody, and one carrying an agent token', async () => {
    const anon = await fetch(`${base}/api/me/messages`);
    expect(anon.status).toBe(401);
    const { token } = handle.boardTokens.mintHeld(A1, ws);
    for (const bearer of [token, at1(A1)]) {
      const res = await fetch(`${base}/api/me/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ text: 'as the agent' }),
      });
      expect([401, 403]).toContain(res.status);
    }
    expect((await read(alice)).messages.map((m) => m.text)).not.toContain('as the agent');
  });

  it("opens a person's own stream on their cookie alone: never a widget or agent token", async () => {
    const stream = (headers: Record<string, string>) =>
      fetch(`${base}/workspaces/${ws}/me/events:stream`, { headers: { ...SSE, ...headers } });
    // Alice's widget token for this board, from this server's own page: a
    // script on any page running the widget holds one like it.
    const wt2 = mintBoardWidgetToken(
      // Session-bound, as the widget's own mint issues it.
      { identityId: alice.user.id, workspaceId: ws, origin: base, sessionId: 'sess-harborlight' },
      widgetTokenKey(loadCookieKey(dataDir)),
    );
    const widget = { origin: base, authorization: `Bearer ${wt2}` };
    // The token stands on its own: it opens the board's stream.
    const board = await fetch(`${base}/workspaces/${ws}/events:stream`, {
      headers: { ...SSE, ...widget },
    });
    expect(board.status).toBe(200);
    await board.body?.cancel();
    const { token: at2 } = handle.boardTokens.mintHeld(A1, ws);
    const refused = [
      await stream(widget),
      // The cookie beside a token does not rescue it: the request carries a
      // credential a host page can hold.
      await stream({ ...alice.headers, authorization: `Bearer ${wt2}` }),
      await stream({ authorization: `Bearer ${at2}` }),
    ];
    for (const res of refused) {
      expect([401, 403]).toContain(res.status);
      await res.body?.cancel();
    }
    // Positive control: the same person's cookie opens it.
    const mine = await stream(alice.headers);
    expect(mine.status).toBe(200);
    await mine.body?.cancel();
  });

  it('lets A1 reply with the board token the server holds for it', async () => {
    const { token } = handle.boardTokens.mintHeld(A1, ws);
    expect((await reply(A1, alice.user.id, 'Over my board token', token)).status).toBe(200);
    const { token: b1Token } = handle.boardTokens.mintHeld(B1, ws);
    expect((await reply(A1, alice.user.id, 'B1 posing as A1', b1Token)).status).toBe(403);
    await waitFor(() => saw('alice', 'Over my board token'), { describe: 'the at2 reply' });
  });
});

describe('a share visitor and private messages', () => {
  it('refuses /api/me/messages to a share visitor, however they proved themselves', async () => {
    const s = await startShareProofServer('Harborlight private');
    try {
      s.handle.shareLinks.addToAudience(s.board, ['alice@harborlight.example'], 'Saltmarsh');
      expect(await s.join('alice@harborlight.example')).toBe(302);
      const get = await s.visitor('alice@harborlight.example', '/api/me/messages');
      expect(get.status).toBeGreaterThanOrEqual(400);
      const sent = await s.visitor('alice@harborlight.example', '/api/me/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'from the share host' }),
      });
      expect(sent.status).toBeGreaterThanOrEqual(400);
    } finally {
      await s.stop();
    }
  });
});
