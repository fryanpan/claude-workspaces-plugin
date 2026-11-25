/**
 * A lead on a project machine dies, and Team Lead on the Mac hears it.
 *
 * Two real servers on loopback. The project server holds a board whose lead
 * holds no stream, with a stuck task; Team Lead is configured there but is
 * attached only to the Mac. The project server runs with no Access in front
 * (`better-auth`), as a project machine does, so the Mac pulls the board's
 * home feed (`home-remotes.ts`) with an `at2` minted for Team Lead on that
 * board, through a stand-in for the tunnel that carries it to the project
 * server's port with `cf-ray` set.
 *
 * What this proves: the project server's feed carries the escalation; the
 * Mac's own stall pass sends Team Lead a stall frame about the REMOTE board,
 * naming the seat and the origin, and tells the project server Team Lead has
 * it, so the project server files NO item for the owner; a board there that
 * no Mac follows still files at once; and the feed stops carrying the
 * escalation once the lead is back. Team Lead's own read of the remote
 * boards (`GET /api/home-remotes` on the Mac) carries the lead's status from
 * the project server: not live while it is dead, live once it is back.
 *
 * All fixtures are synthetic — invented names. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_SIGNIN_FILE } from '../src/auth/owner-signin-record.ts';
import { type FetchLike, parseHomeRemotesConfig } from '../src/home-remotes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import { waitFor } from './wait-for.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-riverbend-lead', name: 'Riverbend Lead', kind: 'agent' };
const TEAM_LEAD = 'agent-harbour-master';
const MAC_ORIGIN = 'mac-origin.harborlight.test';
const CLOUD_ORIGIN = 'riverbend-origin.harborlight.test';
const CLOUD_HOST = 'riverbend-workspaces.harborlight.test';
const OWNER = 'owner@harborlight.test';
/** How long the project server waits for Team Lead's word before filing. */
const GRACE_MS = 1500;

type Frame = { event: string; data?: Record<string, unknown> };

/** Every named frame on an open event stream, as it arrives. */
function frames(res: Response): { list: Frame[]; stop: () => Promise<void> } {
  const list: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          const event = /^event: (.+)$/m.exec(raw)?.[1];
          const data = /^data: (.+)$/m.exec(raw)?.[1];
          if (event) list.push({ event, ...(data ? { data: JSON.parse(data) } : {}) });
        }
      }
    } catch {
      // Cancelled with a read in flight.
    }
  })();
  return {
    list,
    stop: async () => {
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

describe('a dead board on another server reaches Team Lead on the Mac', () => {
  const dirs: string[] = [];
  const streams: Array<{ stop: () => Promise<void> }> = [];
  let cloud: ServerHandle;
  let mac: ServerHandle;
  let board: string;
  let taskId: string;
  /** A task on a second dead board there, which no Mac follows. */
  let loneTask: string;
  /** Each answer the project server gave the Mac's acknowledgement. */
  const acks: unknown[] = [];

  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-escalation-'));
    dirs.push(dir);
    return dir;
  };
  const call = async <T>(handle: ServerHandle, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  const stream = async (handle: ServerHandle, ws: string, agentId: string) => {
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/workspaces/${ws}/events:stream?agentId=${encodeURIComponent(agentId)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    const s = frames(res);
    streams.push(s);
    return s;
  };
  type RemoteRow = { boardId: string; reached: boolean; lead?: Record<string, unknown> };
  const macLead = async () =>
    (await call<{ boards: RemoteRow[] }>(mac, '/api/home-remotes')).boards.find(
      (b) => b.boardId === board,
    )?.lead;
  const cloudFeed = () =>
    call<{ escalation?: Record<string, unknown> }>(cloud, `/workspaces/${board}/home-feed`);

  /** An `at2` for one agent on one board, minted on the project server. */
  const mint = async (boardId: string, agentId: string) =>
    (
      await call<{ token: string }>(cloud, '/api/board-tokens', {
        agentId,
        boardId,
        label: agentId,
      })
    ).token;
  /** The tunnel: to the project server's port, its host kept, `cf-ray` set. */
  const tunnel = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${cloud.port}${path}`, {
      ...init,
      headers: {
        ...((init.headers as Record<string, string>) ?? {}),
        host: CLOUD_HOST,
        'cf-ray': '8a1b2c3d4e5f-SJC',
        'x-forwarded-proto': 'https',
      },
    });
  const ack = (token: string | null, deadSince: number) =>
    tunnel(`/workspaces/${board}/home-feed/escalation-ack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ deadSince }),
    });

  beforeAll(async () => {
    const cloudDir = tmp();
    // The owner signed in once already, so `better-auth` is in force and no
    // Access is in front: the project machine's shape.
    writeFileSync(
      join(cloudDir, OWNER_SIGNIN_FILE),
      JSON.stringify({ email: OWNER, at: '2026-11-19T10:00:00.000Z' }),
      { mode: 0o600 },
    );
    cloud = createServer({
      port: 0,
      dataDir: cloudDir,
      proxiedTrustedHosts: [CLOUD_HOST],
      proxiedTrustedEmails: [OWNER],
      signIn: {
        mode: 'better-auth',
        origin: `https://${CLOUD_HOST}`,
        google: { clientId: 'shared-client', clientSecret: 'stub-secret' },
      },
      stallNudgeQuietMs: 200,
      stallEscalateMs: 0,
      stallRemoteAckGraceMs: GRACE_MS,
      observedWorkFreshMs: 0,
      keepMovingCadenceMs: 0,
      // Configured, and never on this server: the production shape.
      spawnerAgentId: TEAM_LEAD,
    });
    /** A board whose lead holds no stream, with one task stuck in progress. */
    const deadBoard = async (name: string): Promise<[string, string]> => {
      const {
        workspace: { id },
      } = await call<{ workspace: { id: string } }>(cloud, '/workspaces', {
        name,
        leadAgentId: LEAD.id,
      });
      await call(cloud, `/workspaces/${id}/agents`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      });
      const {
        task: { id: task },
      } = await call<{ task: { id: string } }>(cloud, `/workspaces/${id}/tasks`, {
        title: 'Rank results by recency',
        body: 'Agent can rank results by recency so that the queue keeps moving.',
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      });
      for (const [to, author] of [
        ['todo', PERSON],
        ['in-progress', LEAD],
      ] as const) {
        await call(cloud, `/workspaces/${id}/tasks/${task}/transition`, {
          to,
          author,
          workspaceId: id,
        });
      }
      return [id, task];
    };
    [board, taskId] = await deadBoard('riverbend');
    [, loneTask] = await deadBoard('saltmarsh');

    const config = parseHomeRemotesConfig(
      JSON.stringify({
        address: 'https://workspaces.harborlight.test',
        self: MAC_ORIGIN,
        boardOrigins: { [MAC_ORIGIN]: ['w-unused'], [CLOUD_ORIGIN]: [board] },
        boardTokens: { [board]: await mint(board, TEAM_LEAD) },
        addresses: { [CLOUD_ORIGIN]: `https://${CLOUD_HOST}` },
      }),
    );
    if ('error' in config) throw new Error(config.error);
    // The edge, reduced to what this test is about: the project address
    // carried through the tunnel to the project server.
    const edge: FetchLike = async (input, init) => {
      const url = new URL(input);
      const res = await tunnel(`${url.pathname}${url.search}`, init);
      if (url.pathname.endsWith('/escalation-ack')) acks.push(await res.clone().json());
      return res;
    };
    mac = createServer({
      port: 0,
      dataDir: tmp(),
      keepMovingCadenceMs: 0,
      spawnerAgentId: TEAM_LEAD,
      homeRemotes: { config, fetch: edge, retryMs: 50 },
    });
  });

  afterAll(async () => {
    for (const s of streams.splice(0)) await s.stop();
    await mac?.stop();
    await cloud?.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('tells Team Lead on the Mac, and the project server asks its owner nothing', async () => {
    const { workspace: harbour } = await call<{ workspace: { id: string } }>(mac, '/workspaces', {
      name: 'harbour',
    });
    await call(mac, `/workspaces/${harbour.id}/agents`, {
      agentId: TEAM_LEAD,
      runtime: 'claude-code-local',
    });
    const teamLead = await stream(mac, harbour.id, TEAM_LEAD);

    // The project server finds nobody to tell here; its feed says so.
    const feed = await waitFor(async () => {
      cloud.nudgeStalls();
      const f = await cloudFeed();
      return f.escalation ? f : undefined;
    });
    expect(feed.escalation).toMatchObject({ stuck: 1, lead: LEAD.id });
    // POSITIVE CONTROL for the absence below: on the same server, the board
    // no Mac follows files for its owner with no grace. Polled, because each
    // board is judged in its own pass and need not be dead on this one yet.
    await waitFor(() => {
      cloud.nudgeStalls();
      return cloud.tasks.listReviewItems(loneTask).length > 0;
    });
    const deadSince = feed.escalation?.deadSince as number;

    // The Mac's own pass tells Team Lead, once the feed has been re-read.
    const told = await waitFor(() => {
      mac.nudgeStalls();
      return teamLead.list.find((f) => f.event === STALL_EVENT);
    });
    expect(told.data).toMatchObject({
      workspaceId: board,
      escalatedFrom: LEAD.id,
      remote: { origin: CLOUD_ORIGIN, stuck: 1, deadSince: feed.escalation?.deadSince },
    });
    // …and says so to the project server, which takes the word.
    await waitFor(() => acks.length > 0);
    expect(acks[0]).toEqual({ held: true });
    // Nobody else's word is taken: not the dead board's own lead with its
    // `at2` for the board, not a caller on the project machine itself, and
    // not a word about another stretch.
    expect((await ack(await mint(board, LEAD.id), deadSince)).status).toBe(403);
    expect((await ack(null, deadSince)).status).toBe(403);
    const fromHere = await fetch(
      `http://127.0.0.1:${cloud.port}/workspaces/${board}/home-feed/escalation-ack`,
      { method: 'POST', body: JSON.stringify({ deadSince }) },
    );
    expect(fromHere.status).toBe(403);
    const other = await ack(await mint(board, TEAM_LEAD), deadSince - 1);
    expect(await other.json()).toEqual({ held: false });
    // timed: past the grace, so only the word keeps the owner's item off.
    await waitFor(() => Date.now() - deadSince > GRACE_MS, { timeout: GRACE_MS + 5000 });
    for (let i = 0; i < 3; i++) cloud.nudgeStalls();
    expect(cloud.tasks.listReviewItems(taskId)).toEqual([]);
    // Once per dead stretch: more passes add nothing.
    mac.nudgeStalls();
    mac.nudgeStalls();
    expect(teamLead.list.filter((f) => f.event === STALL_EVENT)).toHaveLength(1);
    // Team Lead reads the lead's status from here, without the board.
    expect(await macLead()).toMatchObject({ agentId: LEAD.id, live: false });
  });

  it('the feed stops carrying it once the lead is back, with no item left to withdraw', async () => {
    // No item was filed, so the lead's return withdraws nothing. That the
    // board then tells Home its feed moved is pinned in
    // stall-escalation.test.ts: here the lead's own stall wake also lands on
    // Home, so a frame on this stream could not tell the two apart.
    expect((await cloudFeed()).escalation).toBeDefined();
    await stream(cloud, board, LEAD.id);
    await waitFor(async () => {
      cloud.nudgeStalls();
      return (await cloudFeed()).escalation === undefined;
    });
    const lead = await waitFor(async () => {
      const l = await macLead();
      return l?.live === true ? l : undefined;
    });
    expect(lead.lastSeenAt).toBeGreaterThan(0);
  });
});
