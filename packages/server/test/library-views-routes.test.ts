/**
 * The Library's Recently Viewed list over real HTTP: a person's page opening
 * lands at the top of THEIR list with its time, an agent's read never lands
 * on anybody's, and an open Library hears the view.
 *
 * All fixtures synthetic. Port 0, temp data dirs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LibraryPayload } from '../src/library.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type SignedInPerson, signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

// What a page's body claims. A browser's claim names nobody (the server sets
// every name), so each person below is proven by the session cookie their
// own sign-in set, and the claim rides along unread.
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };
const BOB = { id: 'known-bob', name: 'Bob', kind: 'known' };

describe('library view routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let WS = '';
  const host = { host: 'localhost' };
  /** What a browser tab sends: it sets Origin and Sec-Fetch-* itself. */
  const browser = () => ({ ...host, origin: base, 'sec-fetch-site': 'same-origin' });
  let alice: SignedInPerson;
  let bob: SignedInPerson;
  /** Alice's own browser tab, signed in. */
  const asAlice = () => ({ ...alice.headers });
  const asBob = () => ({ ...bob.headers });
  const view = async (docId: string, author: unknown, headers: Record<string, string>) => {
    const res = await fetch(`${base}/workspaces/${WS}/library/views`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ docId, author }),
    });
    return { status: res.status, body: (await res.json()) as { recorded?: boolean } };
  };
  const items = async (viewer: string): Promise<LibraryPayload> =>
    (await (
      await fetch(`${base}/workspaces/${WS}/library/items?viewer=${viewer}`, { headers: host })
    ).json()) as LibraryPayload;
  const makeDoc = async (alias: string): Promise<string> => {
    const path = join(dataDir, `${alias}.md`);
    writeFileSync(path, `# ${alias}\n`);
    const res = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { ...host, 'content-type': 'application/json' },
      body: JSON.stringify({ docId: alias, type: 'markdown', sourceUrl: path }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { docId: string }).docId;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'library-views-'));
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base, { name: 'Harborlight' });
    alice = signedInPerson(handle, dataDir, base, {
      email: 'alice@harborlight.example',
      name: 'Alice',
    });
    bob = signedInPerson(handle, dataDir, base, { email: 'bob@harborlight.example', name: 'Bob' });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('puts a person’s view at the top of their own list, with its time', async () => {
    const plan = await makeDoc('riverbend-plan');
    const notes = await makeDoc('saltmarsh-notes');
    const t0 = Date.now();
    expect((await view(plan, ALICE, asAlice())).body.recorded).toBe(true);
    expect((await view(notes, ALICE, asAlice())).body.recorded).toBe(true);
    const mine = (await items(alice.user.id)).viewed ?? [];
    expect(mine.map((v) => v.docId)).toEqual([notes, plan]);
    expect(mine[0]?.at).toBeGreaterThanOrEqual(t0);
    // Opening the older one again brings it back to the top.
    await view(plan, ALICE, asAlice());
    expect(((await items(alice.user.id)).viewed ?? []).map((v) => v.docId)).toEqual([plan, notes]);
    // Each person sees their own list only.
    expect((await items(bob.user.id)).viewed).toBeUndefined();
    await view(notes, BOB, asBob());
    expect(((await items(bob.user.id)).viewed ?? []).map((v) => v.docId)).toEqual([notes]);
    expect((await items('')).viewed).toBeUndefined();
  });

  it('never lists an agent’s read', async () => {
    const plan = await makeDoc('riverbend-plan');
    // An agent reads the doc over REST, the way the MCP tools do.
    const read = await fetch(`${base}/workspaces/${WS}/docs/${plan}/content`, { headers: host });
    expect(read.status).toBe(200);
    // Posting a view without a browser's headers records nothing, whoever it names.
    expect((await view(plan, ALICE, host)).body.recorded).toBe(false);
    // A browser cannot claim to be an agent or anybody else: the claim is
    // not read, so neither claimed id gets a list.
    const agent = { id: 'agent-harborlight-lead', name: 'Lead', kind: 'agent' };
    await view(plan, agent, browser());
    await view(plan, { id: 'anon-1', name: 'Guest', kind: 'anon' }, browser());
    expect((await items('anon-1')).viewed).toBeUndefined();
    expect((await items(alice.user.id)).viewed).toBeUndefined();
    expect((await items('agent-harborlight-lead')).viewed).toBeUndefined();
    // Positive control: the same doc, from a person's browser, is listed.
    expect((await view(plan, ALICE, asAlice())).body.recorded).toBe(true);
    expect(((await items(alice.user.id)).viewed ?? []).map((v) => v.docId)).toEqual([plan]);
  });

  it('refuses a doc that is not on the board and a missing id', async () => {
    expect((await view('not-here', ALICE, asAlice())).status).toBe(404);
    expect((await view('', ALICE, asAlice())).status).toBe(400);
    const get = await fetch(`${base}/workspaces/${WS}/library/views`, { headers: host });
    expect(get.status).toBe(405);
  });

  const star = async (body: Record<string, unknown>, headers: Record<string, string>) => {
    const res = await fetch(`${base}/workspaces/${WS}/library/stars`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { recorded?: boolean } };
  };
  const starsOf = async (viewer: string) =>
    (
      (await (
        await fetch(`${base}/workspaces/${WS}/library/stars?viewer=${viewer}`, { headers: host })
      ).json()) as { starred: Array<{ kind: string; id: string }> }
    ).starred.map((s) => `${s.kind}:${s.id}`);

  it('stars and unstars a doc and a folder, each person their own', async () => {
    const plan = await makeDoc('riverbend-plan');
    const made = await fetch(`${base}/workspaces/${WS}/library/folders`, {
      method: 'POST',
      headers: { ...host, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Saltmarsh' }),
    });
    const folderId = ((await made.json()) as { folder: { id: string } }).folder.id;
    expect(
      (await star({ kind: 'doc', id: plan, starred: true, author: ALICE }, asAlice())).body
        .recorded,
    ).toBe(true);
    expect(
      (await star({ kind: 'folder', id: folderId, starred: true, author: ALICE }, asAlice())).body
        .recorded,
    ).toBe(true);
    expect(await starsOf(alice.user.id)).toEqual([`folder:${folderId}`, `doc:${plan}`]);
    // The Library's own read carries them too.
    expect((await items(alice.user.id)).starred?.map((s) => s.id)).toEqual([folderId, plan]);
    // Bob sees none of Alice's.
    expect(await starsOf(bob.user.id)).toEqual([]);
    expect((await items(bob.user.id)).starred).toBeUndefined();
    // Unstar.
    await star({ kind: 'doc', id: plan, starred: false, author: ALICE }, asAlice());
    expect(await starsOf(alice.user.id)).toEqual([`folder:${folderId}`]);
  });

  it('never stars for an agent, and refuses what is not on the board', async () => {
    const plan = await makeDoc('riverbend-plan');
    const agent = { id: 'agent-harborlight-lead', name: 'Lead', kind: 'agent' };
    // A browser's agent claim is not read: nothing is starred for the agent.
    await star({ kind: 'doc', id: plan, starred: true, author: agent }, browser());
    expect(await starsOf(agent.id)).toEqual([]);
    expect(
      (await star({ kind: 'doc', id: plan, starred: true, author: ALICE }, host)).body.recorded,
    ).toBe(false);
    expect(await starsOf(alice.user.id)).toEqual([]);
    expect(
      (await star({ kind: 'doc', id: 'nope', starred: true, author: ALICE }, asAlice())).status,
    ).toBe(404);
    expect(
      (await star({ kind: 'folder', id: 'f-nope', starred: true, author: ALICE }, asAlice()))
        .status,
    ).toBe(404);
    expect(
      (await star({ kind: 'task', id: plan, starred: true, author: ALICE }, asAlice())).status,
    ).toBe(400);
    expect((await star({ kind: 'doc', id: plan, author: ALICE }, asAlice())).status).toBe(400);
  });

  // End to end only: a doc's own arrival sends two Library frames, so this
  // case alone cannot tell a view's frame from a late one of those. The case
  // that fails when a view stops telling the Library is in library-views.test.ts.
  it('an open Library hears a view', async () => {
    const res = await fetch(`${base}/workspaces/${WS}/events:stream`, { headers: host });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          text += decoder.decode(value, { stream: true });
        }
      } catch {
        // Cancelled with a read in flight.
      }
    })();
    try {
      // The doc's own arrival on the board is a Library change: let that
      // frame land first, so the count below moves only for the view.
      const plan = await makeDoc('riverbend-plan');
      await waitFor(() => text.includes('event: library.changed'));
      const before = text.split('event: library.changed').length;
      await view(plan, ALICE, asAlice());
      await waitFor(() => text.split('event: library.changed').length > before);
    } finally {
      void reader.cancel();
      await pump;
    }
  });
});
