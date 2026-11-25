/**
 * The lead's status on the home feed: what the board's server reports
 * (`leadStatusOf`) and what the Mac keeps of a remote's report (`readLead`).
 * Also the Mac's read of it (`GET /api/home-remotes`, refused to a share
 * visitor) and the feed stream's follower count, which a closed stream must
 * give back. The two-server path is `remote-escalation-across-servers.test.ts`.
 *
 * All fixtures are synthetic — invented names. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { HomeFeedFollowers } from '../src/home-feed-followers.ts';
import { readLead } from '../src/home-feed.ts';
import type { RemoteBoardView } from '../src/home-remotes.ts';
import { type LeadStatusSource, leadStatusOf } from '../src/lead-status.ts';
import type { ShareTarget } from '../src/middleware/host-guard.ts';
import { type HomeFeedRoutesContext, handleHomeFeedRoute } from '../src/routes/home-feed.ts';
import {
  type OpsRouteRequest,
  type OpsRoutesContext,
  handleHomeRemotesRoute,
} from '../src/routes/ops.ts';
import { SseBus } from '../src/sse.ts';

const source = (over: Partial<LeadStatusSource> = {}): LeadStatusSource => ({
  getWorkspace: () => ({ leadAgentId: 'agent-riverbend-lead' }),
  hasLiveAttachmentFor: () => true,
  listAttachments: () => [
    { agentId: 'agent-other', lastHeartbeat: 5, lastToolCallAt: 5 },
    { agentId: 'agent-riverbend-lead', lastHeartbeat: 300, lastToolCallAt: 200 },
  ],
  ...over,
});

describe('leadStatusOf', () => {
  it('reports the lead seat’s own attachment', () => {
    expect(leadStatusOf(source(), 'w-riverbend')).toEqual({
      agentId: 'agent-riverbend-lead',
      live: true,
      lastSeenAt: 300,
      lastToolCallAt: 200,
    });
  });

  it('says not live, with no times, for a lead never attached', () => {
    const s = source({ hasLiveAttachmentFor: () => false, listAttachments: () => [] });
    expect(leadStatusOf(s, 'w-riverbend')).toEqual({
      agentId: 'agent-riverbend-lead',
      live: false,
    });
  });

  it('reports nothing for a board with no lead', () => {
    expect(leadStatusOf(source({ getWorkspace: () => ({}) }), 'w-riverbend')).toBeUndefined();
  });
});

describe('readLead', () => {
  it('keeps a well-formed report', () => {
    const lead = { agentId: 'agent-riverbend-lead', live: false, lastSeenAt: 1_700_000_000_000 };
    expect(readLead(lead)).toEqual(lead);
  });

  it('drops a report whose live is not a boolean, and a bad id or time alone', () => {
    expect(readLead({ agentId: 'agent-riverbend-lead', live: 'yes' })).toBeUndefined();
    expect(readLead(null)).toBeUndefined();
    expect(readLead(['live'])).toBeUndefined();
    expect(
      readLead({ agentId: 'agent-‮evil', live: true, lastSeenAt: 'soon', lastToolCallAt: -1 }),
    ).toEqual({ live: true });
  });
});

const j = (status: number, body: unknown) => Response.json(body, { status });

describe('GET /api/home-remotes', () => {
  const view: RemoteBoardView = {
    boardId: 'w-riverbend',
    boardName: 'Riverbend',
    rows: [
      { key: 'k', kind: 'task-review', title: 'Secret title', ask: 'x', askedBy: 'x', since: 1 },
    ],
    dropped: 0,
    linksRefused: 0,
    reached: true,
    lead: { agentId: 'agent-riverbend-lead', live: false },
  };
  const ctx = { j, remoteBoards: () => [view] } as unknown as OpsRoutesContext;
  const rq = (visitor: ShareTarget | null): OpsRouteRequest => ({
    req: new Request('http://localhost/api/home-remotes'),
    pathname: '/api/home-remotes',
    visitor,
    authorFor: () => undefined,
  });

  it('answers a member with each board’s state and no row text', async () => {
    const res = handleHomeRemotesRoute(ctx, rq(null));
    expect(res?.status).toBe(200);
    const body = await res?.json();
    expect(body).toEqual({
      boards: [
        {
          boardId: 'w-riverbend',
          reached: true,
          waiting: 1,
          lead: { agentId: 'agent-riverbend-lead', live: false },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('Secret title');
  });

  it('refuses a share visitor', () => {
    const visitor = { kind: 'workspace', workspaceId: 'w-riverbend' } as unknown as ShareTarget;
    expect(handleHomeRemotesRoute(ctx, rq(visitor))?.status).toBe(403);
  });
});

describe('the feed stream and its follower', () => {
  it('counts the board followed while the stream is open, and not once it closes', async () => {
    const followers = new HomeFeedFollowers();
    const ctx = {
      sse: new SseBus(),
      boardName: () => 'Riverbend',
      feed: async () => {
        throw new Error('not read');
      },
      verifier: null,
      clientId: undefined,
      peerAddress: () => '127.0.0.1',
      externalAccessOpen: () => true,
      followers,
      j,
    } satisfies HomeFeedRoutesContext;
    const abort = new AbortController();
    const req = new Request('http://localhost/workspaces/w-riverbend/home-feed/events:stream', {
      signal: abort.signal,
    });
    const res = await handleHomeFeedRoute(
      ctx,
      req,
      '/workspaces/w-riverbend/home-feed/events:stream',
    );
    expect(res?.status).toBe(200);
    expect(followers.followed('w-riverbend')).toBe(true);
    abort.abort();
    await res?.body?.cancel().catch(() => {});
    expect(followers.followed('w-riverbend')).toBe(false);
  });
});
