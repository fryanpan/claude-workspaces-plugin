/**
 * A lead on a project machine dies, and Team Lead on the Mac hears it.
 *
 * Two real servers on loopback. The project server holds a board whose lead
 * holds no stream, with a stuck task; Team Lead is configured there but is
 * attached only to the Mac. The Mac pulls the project board's home feed the
 * way it does in production (`home-remotes.ts`), through a fetch that
 * rewrites the one address to the project server's loopback port, which is
 * the caller the feed route admits without Access.
 *
 * What this proves: the project server's feed carries the escalation; the
 * Mac's own stall pass sends Team Lead a stall frame about the REMOTE board,
 * naming the seat and the origin, and tells the project server Team Lead has
 * it, so the project server files NO item for the owner; a board there that
 * no Mac follows still files at once; and the feed stops carrying the
 * escalation once the lead is back.
 *
 * All fixtures are synthetic — invented names. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FetchLike, parseHomeRemotesConfig } from '../src/home-remotes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import { waitFor } from './wait-for.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-riverbend-lead', name: 'Riverbend Lead', kind: 'agent' };
const TEAM_LEAD = 'agent-harbour-master';
const MAC_ORIGIN = 'mac-origin.harborlight.test';
const CLOUD_ORIGIN = 'riverbend-origin.harborlight.test';
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
  const cloudFeed = () =>
    call<{ escalation?: Record<string, unknown> }>(cloud, `/workspaces/${board}/home-feed`);

  beforeAll(async () => {
    cloud = createServer({
      port: 0,
      dataDir: tmp(),
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
        serviceTokens: {
          [CLOUD_ORIGIN]: { clientId: 'test-client.access', clientSecret: 'test-secret' },
        },
      }),
    );
    if ('error' in config) throw new Error(config.error);
    // The edge, reduced to what this test is about: the one address carried
    // to the project server, from a loopback peer with no cf-ray.
    const edge: FetchLike = async (input, init) => {
      const url = new URL(input);
      const res = await fetch(`http://127.0.0.1:${cloud.port}${url.pathname}${url.search}`, {
        ...init,
        headers: { ...((init?.headers as Record<string, string>) ?? {}), host: 'localhost' },
      });
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
    // POSITIVE CONTROL for the absence below: on the same server and tick,
    // the board no Mac follows files for its owner at once.
    expect(cloud.tasks.listReviewItems(loneTask).length).toBeGreaterThan(0);
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
    // timed: past the grace, so only the word keeps the owner's item off.
    await waitFor(() => Date.now() - deadSince > GRACE_MS, { timeout: GRACE_MS + 5000 });
    for (let i = 0; i < 3; i++) cloud.nudgeStalls();
    expect(cloud.tasks.listReviewItems(taskId)).toEqual([]);
    // Once per dead stretch: more passes add nothing.
    mac.nudgeStalls();
    mac.nudgeStalls();
    expect(teamLead.list.filter((f) => f.event === STALL_EVENT)).toHaveLength(1);
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
  });
});
