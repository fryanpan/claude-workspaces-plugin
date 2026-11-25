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
import { emailIdentityId } from '@claude-workspaces/core';
import { commentQueuePath } from '../src/agent-comment-queue.ts';
import { agentTokenKey, mintAgentToken } from '../src/auth/agent-token.ts';
import { mintBoardWidgetToken, widgetTokenKey } from '../src/auth/widget-token.ts';
import { PersonAgentLinks } from '../src/person-agent-link.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import { type Frame, listenFrames } from './doc-activity-stall-harness.ts';
import { post, readJson, startShareProofServer } from './share-proof-harness.ts';
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

describe('a share member and private messages', () => {
  const ALICE = 'alice@harborlight.example';
  const BOB = 'bob@riverbend.example';
  const SALTMARSH = 'saltmarsh@harborlight.example';
  const RIVERBEND = 'riverbend@harborlight.example';
  const R1 = 'agent-riverbend-r1';
  const ELSEWHERE = 'agent-saltmarsh-elsewhere';
  const S1 = 'agent-saltmarsh-s1';
  const OUTSIDER = 'riverbend@saltmarsh.example';
  let bobId = '';
  let s: Awaited<ReturnType<typeof startShareProofServer>>;
  let base = '';
  const at1 = (agentId: string) => mintAgentToken(agentId, agentTokenKey(loadCookieKey(s.dataDir)));
  const pageOf = async (res: Response) => {
    expect(res.status).toBe(200);
    return (await res.json()) as {
      agentId: string;
      messages: Array<{ from: string; text: string; personId: string }>;
    };
  };
  /** Alice and Bob each name and are confirmed by their own agent, as they
   *  would from their profile; the link is the person's, whichever host. */
  async function link(email: string, agentId: string) {
    const who = signedInPerson(s.handle, s.dataDir, base, { email });
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
    return who.user.id;
  }
  const reply = (agentId: string, personId: string, text: string) =>
    fetch(`${base}/api/agents/${agentId}/messages/${encodeURIComponent(personId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${at1(agentId)}` },
      body: JSON.stringify({ text }),
    });

  beforeAll(async () => {
    s = await startShareProofServer('Harborlight private');
    base = `http://127.0.0.1:${s.handle.port}`;
    s.handle.shareLinks.addToAudience(s.board, [ALICE, BOB, SALTMARSH, RIVERBEND], 'Saltmarsh');
    for (const email of [ALICE, BOB, SALTMARSH, RIVERBEND]) {
      expect(await s.join(email)).toBe(302);
    }
    for (const [agentId, name] of [
      [A1, 'Harborlight'],
      [B1, 'Riverbend'],
      [R1, 'Riverbend One'],
      [S1, 'Saltmarsh One'],
    ] as const) {
      s.handle.tasks.attachAgent(s.board, {
        agentId,
        agentName: name,
        runtime: 'claude-code-local',
      });
      s.handle.identities.upsertAgent(agentId, name);
    }
    const aliceId = await link(ALICE, A1);
    bobId = await link(BOB, B1);
    // An agent on a board none of these members is on.
    const other = await readJson<{ workspace: { id: string } }>(
      await s.local('/workspaces', post({ name: 'Saltmarsh elsewhere' })),
    );
    s.handle.tasks.attachAgent(other.workspace.id, {
      agentId: ELSEWHERE,
      agentName: 'Elsewhere',
      runtime: 'claude-code-local',
    });
    expect((await reply(A1, aliceId, 'Alice, the tide is at six')).status).toBe(200);
    expect((await reply(B1, bobId, 'Bob, the ferry is late')).status).toBe(200);
  });

  afterAll(async () => {
    await s.stop();
  });

  it('reads the message her own agent sent her from the share host, and never the one sent to Bob', async () => {
    const alice = await pageOf(await s.visitor(ALICE, '/api/me/messages'));
    expect(alice.agentId).toBe(A1);
    expect(alice.messages.map((m) => m.text)).toEqual(['Alice, the tide is at six']);
    const bob = await pageOf(await s.visitor(BOB, '/api/me/messages'));
    expect(bob.messages.map((m) => m.text)).toEqual(['Bob, the ferry is late']);
  });

  it("never reads another member's conversation, whatever the query names", async () => {
    for (const query of ['', `?personId=${bobId}`, `?agentId=${B1}`, `?with=${bobId}`]) {
      const alice = await pageOf(await s.visitor(ALICE, `/api/me/messages${query}`));
      expect(alice.agentId).toBe(A1);
      expect(alice.messages.some((m) => m.text === 'Bob, the ferry is late')).toBe(false);
    }
  });

  it('sends to her own agent from the share host, and the reply names her', async () => {
    const sent = await s.visitor(ALICE, '/api/me/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Thanks, A1' }),
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ agentId: A1, message: { from: 'person' } });
    const bob = await pageOf(await s.visitor(BOB, '/api/me/messages'));
    expect(bob.messages.some((m) => m.text === 'Thanks, A1')).toBe(false);
  });

  it('still refuses a share visitor carrying a token, and names a missing lead agent', async () => {
    const tokened = await s.visitor(ALICE, '/api/me/messages', {
      headers: { authorization: `Bearer ${at1(A1)}` },
    });
    expect(tokened.status).toBe(403);
    const unlinked = await s.visitor(SALTMARSH, '/api/me/messages');
    expect(unlinked.status).toBe(409);
    expect(await unlinked.json()).toMatchObject({ error: 'no_lead_agent' });
  });

  const profile = (email: string, body: unknown) =>
    s.visitor(email, '/api/auth/profile', post(body));
  /** What a person named, read off the store's file: never a write. */
  const namedBy = (email: string) =>
    new PersonAgentLinks(s.dataDir, s.handle.identities).sidesOf(emailIdentityId(email)).named;
  const queued = () => s.handle.tasks.listQueuedComments(s.board).length;

  it('names a lead agent on their own board from the share host, then messages it', async () => {
    const named = await profile(RIVERBEND, { leadAgentId: R1 });
    expect(named.status).toBe(200);
    const riverbendId = emailIdentityId(RIVERBEND);
    const confirmed = await fetch(`${base}/api/agents/${R1}/person`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${at1(R1)}` },
      body: JSON.stringify({ personId: riverbendId }),
    });
    expect(await confirmed.json()).toMatchObject({ state: 'linked' });
    const sent = await s.visitor(RIVERBEND, '/api/me/messages', post({ text: 'Hello, R1' }));
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ agentId: R1 });
  });

  it('refuses, and changes nothing, an agent on another board, a write naming somebody else, or a name change', async () => {
    const before = s.handle.identities.get(emailIdentityId(ALICE))?.displayName;
    const refusals: Array<[unknown, number, string]> = [
      [{ leadAgentId: ELSEWHERE }, 403, 'agent_not_on_your_board'],
      [{ leadAgentId: B1, personId: bobId }, 403, 'share_member_lead_agent_only'],
      [{ leadAgentId: B1 }, 409, 'agent_claimed'],
      [{ leadAgentId: A1, displayName: 'Bob' }, 403, 'share_member_lead_agent_only'],
      [{ displayName: 'Bob' }, 403, 'share_member_lead_agent_only'],
    ];
    for (const [body, status, error] of refusals) {
      const res = await profile(ALICE, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(await res.json()).toMatchObject({ error });
    }
    expect(s.handle.identities.get(emailIdentityId(ALICE))?.displayName).toBe(before);
    expect(namedBy(ALICE)).toBe(A1);
    expect(namedBy(BOB)).toBe(B1);
    const alice = await pageOf(await s.visitor(ALICE, '/api/me/messages'));
    expect(alice.agentId).toBe(A1);
  });

  it('gives an address that is a member of no board no conversation and no agent', async () => {
    const read = await s.visitor(OUTSIDER, '/api/me/messages');
    expect(read.status).toBe(409);
    for (const agentId of [A1, ELSEWHERE]) {
      const res = await profile(OUTSIDER, { leadAgentId: agentId });
      expect(await res.json()).toMatchObject({ error: 'agent_not_on_your_board' });
    }
    expect(namedBy(OUTSIDER)).toBeNull();
  });

  it("ends a member's conversation while their board is locked, and gives it back after", async () => {
    const sendAsAlice = () => s.visitor(ALICE, '/api/me/messages', post({ text: 'While locked' }));
    expect(s.handle.sharingGate.setBoardLocked(s.board, true)).toMatchObject({ ok: true });
    try {
      const rows = queued();
      expect((await s.visitor(ALICE, '/api/me/messages')).status).toBe(403);
      expect((await sendAsAlice()).status).toBe(403);
      expect(queued()).toBe(rows);
      const renamed = await profile(RIVERBEND, { leadAgentId: R1 });
      expect(await renamed.json()).toMatchObject({ error: 'agent_not_on_your_board' });
    } finally {
      s.handle.sharingGate.setBoardLocked(s.board, false);
    }
    const alice = await pageOf(await s.visitor(ALICE, '/api/me/messages'));
    expect(alice.messages.some((m) => m.text === 'While locked')).toBe(false);
  });

  it("ends a removed member's conversation with the agent they had linked", async () => {
    const saltmarshId = await link(SALTMARSH, S1);
    expect((await s.visitor(SALTMARSH, '/api/me/messages')).status).toBe(200);
    expect(s.handle.shareLinks.removeMember(s.board, SALTMARSH)).toBe(true);
    s.handle.shareLinks.removeFromAudience(s.board, SALTMARSH);
    const rows = queued();
    expect((await s.visitor(SALTMARSH, '/api/me/messages')).status).toBe(403);
    const sent = await s.visitor(SALTMARSH, '/api/me/messages', post({ text: 'After removal' }));
    expect(sent.status).toBe(403);
    expect(queued()).toBe(rows);
    const renamed = await profile(SALTMARSH, { leadAgentId: S1 });
    expect(await renamed.json()).toMatchObject({ error: 'agent_not_on_your_board' });
    expect(new PersonAgentLinks(s.dataDir, s.handle.identities).leadAgentOf(saltmarshId)).toBe(S1);
  });
});
