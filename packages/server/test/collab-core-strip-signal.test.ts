/**
 * How an open board page learns whether the collab core serves its board, so
 * it can pick its presence strip (D1 step 10): the board record carries
 * `collabCore.active`, and `POST /workspaces/<id>/collab-core` tells the
 * board's open pages with a `collab-core.changed` frame. Pages only: an
 * agent acts on nothing in it, and each frame costs a session a turn.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { pageStream } from './lead-chat-page-stream.ts';
import { type ShareProofServer, post, startShareProofServer } from './share-proof-harness.ts';
import { type Frame, listenFrames } from './sse-frames.ts';
import { waitFor } from './wait-for.ts';

const servers: ShareProofServer[] = [];
const streams: Array<{ close: () => void }> = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  for (const s of servers.splice(0)) await s.stop();
});

/** Switching the core on needs the owner's own browser
 *  (`owner-proof-widenings.test.ts`), so the flips here come from it. */
async function boot(
  collabCore: boolean | undefined,
  collabCoreDefault = false,
): Promise<{ base: string; ws: string }> {
  // `collabCoreDefault` is passed either way, so core mode's
  // CW_COLLAB_CORE_DEFAULT cannot start these boards on.
  const s = await startShareProofServer('Harborlight', {
    ...(collabCore !== undefined ? { collabCore } : {}),
    collabCoreDefault,
  });
  servers.push(s);
  return { base: `http://127.0.0.1:${s.handle.port}`, ws: s.board };
}

function serverFor(ws: string): ShareProofServer {
  const s = servers.find((x) => x.board === ws);
  if (!s) throw new Error(`no server for ${ws}`);
  return s;
}

async function record(base: string, ws: string): Promise<unknown> {
  const r = await fetch(`${base}/workspaces/${ws}?format=json`);
  expect(r.status).toBe(200);
  return ((await r.json()) as { collabCore?: unknown }).collabCore;
}

async function flip(ws: string, body: { on?: boolean; serverWide?: boolean }): Promise<void> {
  const r = await serverFor(ws).owner(`/workspaces/${ws}/collab-core`, post(body));
  expect(r.status, await r.clone().text()).toBe(200);
}

async function streamsFor(base: string, ws: string) {
  const res = await fetch(`${base}/workspaces/${ws}/events:stream`, {
    headers: { accept: 'text/event-stream' },
  });
  const page = listenFrames(res);
  const agent = await pageStream(base, ws, 'agent-riverbend');
  streams.push({ close: () => void page.stop() }, agent);
  return { page, agent };
}

const flips = (frames: readonly Frame[]) =>
  frames.filter((f) => f.event === 'collab-core.changed').map((f) => f.data?.active);

describe('the board record and frame that pick the presence strip', () => {
  it('says active once the board is switched on, and tells open pages but no agent', async () => {
    const { base, ws } = await boot(true);
    expect(await record(base, ws)).toMatchObject({ active: false });
    const { page, agent } = await streamsFor(base, ws);

    await flip(ws, { on: true });
    await waitFor(() => flips(page.frames).length === 1, { describe: 'the page hears the flip' });
    expect(flips(page.frames)).toEqual([true]);
    expect(await record(base, ws)).toMatchObject({ active: true });

    // The agent's stream is open and hearing board news (the control): a
    // task filed now reaches it, and the flip before it never did.
    const filed = await fetch(`${base}/workspaces/${ws}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Saltmarsh survey',
        author: { id: 'known-alice', name: 'Alice', kind: 'known' },
      }),
    });
    expect(filed.status).toBeLessThan(300);
    await waitFor(() => agent.events.some((e) => e.startsWith('task.')), {
      describe: 'the agent hears a task event',
    });
    expect(agent.events).not.toContain('collab-core.changed');

    await flip(ws, { on: false });
    await waitFor(() => flips(page.frames).length === 2, {
      describe: 'the page hears the flip back',
    });
    expect(flips(page.frames)).toEqual([true, false]);
    expect(await record(base, ws)).toMatchObject({ active: false });
  });

  it('tells a board on only by default when the server-wide setting flips', async () => {
    // Under CW_COLLAB_CORE_DEFAULT no list names this board, so the switch
    // has to find it among the server's boards to tell its open pages.
    const { base, ws } = await boot(undefined, true);
    expect(await record(base, ws)).toMatchObject({ active: true });
    const { page } = await streamsFor(base, ws);

    await flip(ws, { serverWide: false });
    await waitFor(() => flips(page.frames).length === 1, { describe: 'the page hears it off' });
    expect(flips(page.frames)).toEqual([false]);

    // The board row's own request: both settings in one, the board already
    // on by default. The server-wide half is the change, and it is heard.
    await flip(ws, { on: true, serverWide: true });
    await waitFor(() => flips(page.frames).length === 2, { describe: 'the page hears it on' });
    expect(flips(page.frames)).toEqual([false, true]);
  });

  it('stays inactive on a server started with the collab core off', async () => {
    const { base, ws } = await boot(false);
    await flip(ws, { on: true });
    expect(await record(base, ws)).toMatchObject({ active: false });
  });
});
