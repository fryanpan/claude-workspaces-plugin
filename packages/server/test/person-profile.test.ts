/**
 * A person names themselves and their one lead agent; the agent confirms;
 * a rename reaches pages already open; and a browser that proved nobody
 * does not name its own comments.
 *
 * Real server, port 0, a temp data dir, invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentTokenKey, mintAgentToken } from '../src/auth/agent-token.ts';
import { Identities, type IdentityRecord } from '../src/identities.ts';
import { PersonAgentLinks } from '../src/person-agent-link.ts';
import { handleProfile } from '../src/routes/person-profile.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import { type RoomPage, joinRoom } from './room-page.ts';
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

const j = (status: number, body: unknown) => Response.json(body, { status });
const safeJson = async (req: Request) =>
  (await req.json().catch(() => null)) as Record<string, unknown> | null;

describe('handleProfile, given the identity a proof named', () => {
  let dataDir = '';
  let identities: Identities;
  let alice: IdentityRecord;
  let bob: IdentityRecord;
  const renamed: Array<[string, string]> = [];

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-profile-unit-'));
    identities = new Identities({ dataDir });
    alice = identities.upsertByEmail('alice@example.com');
    bob = identities.upsertByEmail('bob@example.com');
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  const call = (body: unknown, proven: IdentityRecord | null, headers: HeadersInit = {}) =>
    handleProfile(
      {
        identities,
        personAgentLinks: new PersonAgentLinks(dataDir, identities),
        onPersonRenamed: (id, name) => void renamed.push([id, name]),
        j,
        safeJson,
      },
      new Request('http://localhost/api/auth/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      () => proven,
    );

  it('renames the person an Access assertion proved, whatever id the body names', async () => {
    const res = await call({ displayName: 'Riverbend', id: bob.id, personId: bob.id }, alice);
    expect(res.status).toBe(200);
    expect(identities.get(alice.id)?.displayName).toBe('Riverbend');
    expect(identities.get(bob.id)?.displayName).not.toBe('Riverbend');
    expect(renamed.at(-1)).toEqual([alice.id, 'Riverbend']);
  });

  it('refuses a request carrying a token: a widget token or an agent token is not a person', async () => {
    for (const bearer of ['wt2.x.y', 'at2.x.y', 'at1.x']) {
      const res = await call({ displayName: 'Saltmarsh' }, alice, {
        authorization: `Bearer ${bearer}`,
      });
      expect(res.status).toBe(403);
    }
    expect(identities.get(alice.id)?.displayName).not.toBe('Saltmarsh');
  });

  it('refuses a request that proved nobody', async () => {
    expect((await call({ displayName: 'Saltmarsh' }, null)).status).toBe(401);
  });
});

describe('the lead-agent link and live rename, over the real server', () => {
  let handle: ServerHandle;
  let dataDir = '';
  let base = '';
  let ws = '';
  const AGENT = 'harborlight-a1';
  const closers: Array<{ close(): void }> = [];
  const browser = () => ({
    'content-type': 'application/json',
    origin: base,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
  });

  async function signIn(email: string): Promise<string> {
    const before = codes.length;
    await fetch(`${base}/api/auth/start`, {
      method: 'POST',
      headers: browser(),
      body: JSON.stringify({ email }),
    });
    expect(codes.length).toBe(before + 1);
    const res = await fetch(`${base}/api/auth/verify`, {
      method: 'POST',
      headers: browser(),
      body: JSON.stringify({ email, code: codes[codes.length - 1] }),
    });
    expect(res.status).toBe(200);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }

  const profile = (cookie: string, body: unknown) =>
    fetch(`${base}/api/auth/profile`, {
      method: 'POST',
      headers: { ...browser(), cookie },
      body: JSON.stringify(body),
    });
  const confirm = (body: unknown, token?: string) =>
    fetch(`${base}/api/agents/${AGENT}/person`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-profile-'));
    handle = createServer({
      port: 0,
      dataDir,
      emailCodeSignIn: true,
      requireSignInToWrite: false,
    } as Parameters<typeof createServer>[0]);
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base);
    handle.tasks.attachAgent(ws, {
      agentId: AGENT,
      agentName: 'Harborlight',
      runtime: 'claude-code-local',
    });
  });

  afterAll(async () => {
    for (const c of closers.splice(0)) c.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    console.log = originalLog;
  });

  it('links when Alice names her agent and the agent confirms her, and refuses Bob the same agent', async () => {
    const alice = await signIn('alice@example.com');
    const bob = await signIn('bob@example.com');
    const named = await profile(alice, { leadAgentId: AGENT });
    expect(named.status).toBe(200);
    expect(
      ((await named.json()) as { leadAgent: { linked: string | null } }).leadAgent.linked,
    ).toBe(null);
    // The agent side needs its own token.
    expect((await confirm({ email: 'alice@example.com' })).status).toBe(401);
    const at1 = mintAgentToken(AGENT, agentTokenKey(loadCookieKey(dataDir)));
    const confirmed = await confirm({ email: 'alice@example.com' }, at1);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ state: 'linked' });
    const again = await profile(alice, { displayName: 'Alice' });
    expect(
      ((await again.json()) as { leadAgent: { linked: string | null } }).leadAgent.linked,
    ).toBe(AGENT);
    const stolen = await profile(bob, { leadAgentId: AGENT });
    expect(stolen.status).toBe(409);
    expect(await stolen.json()).toMatchObject({ error: 'agent_claimed' });
  });

  it("a page already open sees Alice's new name without a reload", async () => {
    const alice = await signIn('alice@example.com');
    const room = `ws://127.0.0.1:${handle.port}/workspaces/${ws}/y?type=workspace&presence=1`;
    const page: RoomPage = joinRoom(room, base, { cookie: alice });
    const watcher: RoomPage = joinRoom(room, base);
    closers.push(page, watcher);
    await page.ready;
    await watcher.ready;
    page.awareness.setLocalState({ surface: 'board' });
    const nameHeard = () =>
      (watcher.awareness.getStates().get(page.ydoc.clientID) as { user?: { name?: string } })?.user
        ?.name ?? null;
    await waitFor(() => nameHeard() !== null, { describe: "Alice's presence" });
    expect((await profile(alice, { displayName: 'Saltmarsh' })).status).toBe(200);
    await waitFor(() => nameHeard() === 'Saltmarsh', { describe: 'the new name on the open page' });
    // The page's next frame still lands after the server moved its clock.
    page.awareness.setLocalState({ surface: 'board', marker: 'after-rename' });
    await waitFor(
      () =>
        (watcher.awareness.getStates().get(page.ydoc.clientID) as { marker?: string })?.marker ===
        'after-rename',
      { describe: "the page's next state" },
    );
  });

  it('a browser comment that proved nobody is not filed under the name it typed', async () => {
    const file = join(dataDir, 'profile-doc.md');
    writeFileSync(file, '# Heading\n\nSome prose to comment on.\n');
    const made = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'profile-doc', type: 'markdown', sourceUrl: file }),
    });
    expect(made.status).toBe(200);
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/workspaces/${ws}/docs/profile-doc/threads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          author: { id: 'known-bob', name: 'Bob', kind: 'known', color: '#336699' },
          text: 'a comment',
          anchor: {
            kind: 'element',
            fingerprint: {
              tag: 'P',
              stableAttrs: {},
              classes: [],
              text: 'Some',
              path: 'P[0]',
              dataAttrs: {},
            },
            snippet: { text: 'Some' },
          },
        }),
      });
    const fromBrowser = await post(browser());
    expect(fromBrowser.status).toBe(200);
    const { thread } = (await fromBrowser.json()) as {
      thread: { comments: Array<{ author: { id: string; name: string } }> };
    };
    expect(thread.comments[0]?.author.name).not.toBe('Bob');
    expect(thread.comments[0]?.author.id).not.toBe('known-bob');
    // CONTROL: a non-browser caller (an MCP child) still names itself.
    const fromAgent = await post({ 'content-type': 'application/json' });
    const { thread: agentThread } = (await fromAgent.json()) as {
      thread: { comments: Array<{ author: { name: string } }> };
    };
    expect(agentThread.comments[0]?.author.name).toBe('Bob');
  });
});
