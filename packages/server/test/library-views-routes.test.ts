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
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

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
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('puts a person’s view at the top of their own list, with its time', async () => {
    const plan = await makeDoc('riverbend-plan');
    const notes = await makeDoc('saltmarsh-notes');
    const t0 = Date.now();
    expect((await view(plan, ALICE, browser())).body.recorded).toBe(true);
    expect((await view(notes, ALICE, browser())).body.recorded).toBe(true);
    const mine = (await items('known-alice')).viewed ?? [];
    expect(mine.map((v) => v.docId)).toEqual([notes, plan]);
    expect(mine[0]?.at).toBeGreaterThanOrEqual(t0);
    // Opening the older one again brings it back to the top.
    await view(plan, ALICE, browser());
    expect(((await items('known-alice')).viewed ?? []).map((v) => v.docId)).toEqual([plan, notes]);
    // Each person sees their own list only.
    expect((await items('known-bob')).viewed).toBeUndefined();
    await view(notes, BOB, browser());
    expect(((await items('known-bob')).viewed ?? []).map((v) => v.docId)).toEqual([notes]);
    expect((await items('')).viewed).toBeUndefined();
  });

  it('never lists an agent’s read', async () => {
    const plan = await makeDoc('riverbend-plan');
    // An agent reads the doc over REST, the way the MCP tools do.
    const read = await fetch(`${base}/workspaces/${WS}/docs/${plan}/content`, { headers: host });
    expect(read.status).toBe(200);
    // Posting a view without a browser's headers records nothing, whoever it names.
    expect((await view(plan, ALICE, host)).body.recorded).toBe(false);
    // An agent author records nothing, even from a browser.
    const agent = { id: 'agent-harborlight-lead', name: 'Lead', kind: 'agent' };
    expect((await view(plan, agent, browser())).body.recorded).toBe(false);
    // An anonymous reader is nobody to list it for.
    expect(
      (await view(plan, { id: 'anon-1', name: 'Guest', kind: 'anon' }, browser())).body.recorded,
    ).toBe(false);
    expect((await items('known-alice')).viewed).toBeUndefined();
    expect((await items('agent-harborlight-lead')).viewed).toBeUndefined();
    // Positive control: the same doc, from a person's browser, is listed.
    expect((await view(plan, ALICE, browser())).body.recorded).toBe(true);
    expect(((await items('known-alice')).viewed ?? []).map((v) => v.docId)).toEqual([plan]);
  });

  it('refuses a doc that is not on the board and a missing id', async () => {
    expect((await view('not-here', ALICE, browser())).status).toBe(404);
    expect((await view('', ALICE, browser())).status).toBe(400);
    const get = await fetch(`${base}/workspaces/${WS}/library/views`, { headers: host });
    expect(get.status).toBe(405);
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
      await view(plan, ALICE, browser());
      await waitFor(() => text.split('event: library.changed').length > before);
    } finally {
      void reader.cancel();
      await pump;
    }
  });
});
