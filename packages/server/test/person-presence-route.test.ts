/**
 * `POST /workspaces/<ws>/person/watch` and `/person/show` over the real
 * server: an agent hears where the owner's attended tab lands, sends that one
 * tab somewhere, and can do neither for a tab on another board.
 *
 * Real server, port 0, a temp data dir, real `/y` presence sockets standing in
 * for the owner's pages. Which tab a browser reports as attended is the
 * browser test's business (`person-navigate.browser.test.ts`); here each page
 * announces it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTENDING_FIELD,
  DIRECTIVE_FIELD,
  PERSON_SPOT_FIELD,
  type PersonDirective,
  type PresenceSpot,
  parseDirective,
} from '@claude-workspaces/core/workspace-presence';
import { registerOwnerIdentity, resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type RoomPage, agentFrames, joinRoom } from './room-page.ts';
import { waitFor } from './wait-for.ts';

const OWNER = { id: 'known-riverbend', name: 'Riverbend' };
const AGENT = { agentId: 'agent-harborlight', agentName: 'Harborlight' };
const OTHER_AGENT = { agentId: 'agent-saltmarsh', agentName: 'Saltmarsh' };

describe("an agent hearing and moving the owner's tab", () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base = '';
  let ws = '';
  let other = '';
  let docId = '';
  let callerIs: string | null = null;
  const closers: Array<{ close(): void }> = [];

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const bearer = async (agentId: string) => {
    callerIs = agentId;
    const res = await fetch(`${base}/api/agents/${agentId}/token`);
    return { authorization: `Bearer ${((await res.json()) as { token: string }).token}` };
  };
  const room = (board: string) =>
    `ws://127.0.0.1:${handle.port}/workspaces/${board}/y?type=workspace&presence=1`;
  const ownerPage = async (board: string): Promise<RoomPage> => {
    const page = joinRoom(room(board), base);
    closers.push(page);
    await page.ready;
    return page;
  };
  const announce = (page: RoomPage, spot: PresenceSpot, attending: boolean) =>
    page.awareness.setLocalState({
      user: OWNER,
      surface: spot.surface,
      [PERSON_SPOT_FIELD]: spot,
      [ATTENDING_FIELD]: attending,
    });
  /** The directive a page hears from the server, if any. */
  const directiveHeardBy = (page: RoomPage): PersonDirective | null => {
    for (const [id, s] of page.awareness.getStates()) {
      if (id === page.ydoc.clientID) continue;
      const d = parseDirective((s as Record<string, unknown>)[DIRECTIVE_FIELD]);
      if (d) return d;
    }
    return null;
  };

  beforeAll(async () => {
    registerOwnerIdentity(OWNER.id);
    dataDir = mkdtempSync(join(tmpdir(), 'cw-person-presence-'));
    handle = createServer({
      port: 0,
      dataDir,
      requireSignInToWrite: false,
      identifyAgentCaller: async () =>
        callerIs ? { ok: true, agentId: callerIs, via: 'session' } : { ok: false },
    } as Parameters<typeof createServer>[0]);
    base = `http://127.0.0.1:${handle.port}`;
    const made = async (name: string) =>
      ((await (await post('/workspaces', { name })).json()) as { workspace: { id: string } })
        .workspace.id;
    ws = await made('Harborlight');
    other = await made('Riverbend');
    handle.tasks.attachAgent(ws, { ...AGENT, runtime: 'claude-code-local' });
    handle.tasks.attachAgent(other, { ...OTHER_AGENT, runtime: 'claude-code-local' });
    const file = join(dataDir, 'plan.md');
    writeFileSync(file, '# Compliance plan\n\n## Retention\n\nSeven years.\n');
    docId = (
      (await (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'plan',
          type: 'markdown',
          sourceUrl: file,
          title: 'Compliance plan',
        })
      ).json()) as { docId: string }
    ).docId;
  });

  afterAll(async () => {
    for (const c of closers.splice(0)) c.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    resetOwnerIdentities();
  });

  it('a watching agent hears the owner land on a doc within a second, naming board, doc and place', async () => {
    const stream = await agentFrames(base, ws, AGENT.agentId);
    closers.push(stream);
    const watched = await post(
      `/workspaces/${ws}/person/watch`,
      { ...AGENT },
      await bearer(AGENT.agentId),
    );
    expect(watched.status, await watched.clone().text()).toBe(200);
    const page = await ownerPage(ws);
    announce(page, { surface: 'doc', docId, blockId: 'b-retention' }, true);
    // The bound is the criterion's own one second: settle (300ms) plus a hop.
    await waitFor(() => stream.frames.some((f) => f.event === 'person.landed'), {
      timeout: 1_000,
      describe: 'a person.landed frame on the agent stream',
    });
    expect(stream.frames.find((f) => f.event === 'person.landed')).toMatchObject({
      workspaceId: ws,
      person: { id: OWNER.id },
      resource: { kind: 'doc', id: docId, title: 'Compliance plan' },
      spot: { docId, blockId: 'b-retention' },
    });
    page.close();
  });

  it('show addresses only the tab the owner is attending to', async () => {
    const background = await ownerPage(ws);
    const front = await ownerPage(ws);
    announce(background, { surface: 'board', path: `/workspaces/${ws}` }, false);
    announce(front, { surface: 'board', path: `/workspaces/${ws}/home` }, true);
    const auth = await bearer(AGENT.agentId);
    await waitFor(
      async () =>
        (
          (await (await post(`/workspaces/${ws}/person/watch`, { ...AGENT }, auth)).json()) as {
            landing: unknown;
          }
        ).landing !== null,
      { describe: 'the server sees the attended tab' },
    );
    const shown = await post(
      `/workspaces/${ws}/person/show`,
      { ...AGENT, docId, blockId: 'b-retention' },
      auth,
    );
    expect(shown.status, await shown.clone().text()).toBe(200);
    await waitFor(() => directiveHeardBy(front) !== null, {
      describe: 'the directive reaches pages',
    });
    const d = directiveHeardBy(front);
    expect(d?.to).toBe(front.ydoc.clientID);
    expect(d?.to).not.toBe(background.ydoc.clientID);
    expect(d?.spot).toMatchObject({ surface: 'doc', docId, blockId: 'b-retention' });
    expect(d?.by).toEqual({ id: AGENT.agentId, name: AGENT.agentName });
    background.close();
    front.close();
  });

  it("an agent on one board neither hears nor moves the owner's tab on another", async () => {
    const stream = await agentFrames(base, ws, AGENT.agentId);
    closers.push(stream);
    const auth = await bearer(AGENT.agentId);
    await post(`/workspaces/${ws}/person/watch`, { ...AGENT }, auth);
    const elsewhere = await ownerPage(other);
    announce(elsewhere, { surface: 'board', path: `/workspaces/${other}/home` }, true);
    // A control on the other board: its own agent hears the same landing, so
    // silence on this one is the wall and not a slow server.
    const otherStream = await agentFrames(base, other, OTHER_AGENT.agentId);
    closers.push(otherStream);
    await post(
      `/workspaces/${other}/person/watch`,
      { ...OTHER_AGENT },
      await bearer(OTHER_AGENT.agentId),
    );
    announce(elsewhere, { surface: 'board', path: `/workspaces/${other}/library` }, true);
    await waitFor(() => otherStream.frames.some((f) => f.event === 'person.landed'), {
      describe: 'the other board hears its own landing',
    });
    expect(stream.frames.filter((f) => f.event === 'person.landed')).toEqual([]);

    const moved = await post(
      `/workspaces/${ws}/person/show`,
      { ...AGENT, docId },
      await bearer(AGENT.agentId),
    );
    expect(moved.status).toBe(409);
    expect(((await moved.json()) as { error: string }).error).toBe('not-here');
    // Nor may it name the other board: it is not attached there.
    const across = await post(
      `/workspaces/${other}/person/show`,
      { ...AGENT, path: 'home' },
      await bearer(AGENT.agentId),
    );
    expect(across.status).toBe(403);
    const peek = await post(
      `/workspaces/${other}/person/watch`,
      { ...AGENT },
      await bearer(AGENT.agentId),
    );
    expect(peek.status).toBe(403);
    expect(directiveHeardBy(elsewhere)).toBeNull();
    elsewhere.close();
  });

  it('refuses a caller without the agent token', async () => {
    callerIs = null;
    const res = await post(`/workspaces/${ws}/person/show`, { ...AGENT, path: 'home' });
    expect(res.status).toBe(401);
  });
});
