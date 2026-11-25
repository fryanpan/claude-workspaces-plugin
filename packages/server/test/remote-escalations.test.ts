/**
 * A board on another server with nobody on it, told to THIS server's Team
 * Lead: the Mac reads the escalation off the board's home feed
 * (`home-remotes.ts`) and sends the frame (`remote-escalations.ts`). Driven
 * directly with a fake reach; the two-server proof is
 * `remote-escalation-across-servers.test.ts`.
 *
 * All fixtures are synthetic — invented names. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { HomeFeedEscalation } from '../src/home-feed.ts';
import type { RemoteBoardView } from '../src/home-remotes.ts';
import {
  RemoteEscalations,
  type RemoteReach,
  type RemoteStallFrame,
} from '../src/remote-escalations.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';

const TEAM_LEAD = 'agent-harbour-master';
const BOARD = 'w-riverbend';
const ORIGIN = 'riverbend-origin.harborlight.test';
const SINCE = Date.UTC(2026, 10, 20, 9);
const NOW = SINCE + 2 * 60 * 60_000;

function setup() {
  const sent: Array<{ on: string; to: string; frame: RemoteStallFrame }> = [];
  const reachOn = new Set(['w-harbour']);
  const reach: RemoteReach = {
    agentId: TEAM_LEAD,
    boards: () => ['w-other', 'w-harbour'],
    canReach: (ws, id) => id === TEAM_LEAD && reachOn.has(ws),
    send: (on, to, frame) => {
      sent.push({ on, to, frame });
      return reachOn.has(on) ? 1 : 0;
    },
  };
  const relay = new RemoteEscalations({
    teamLead: reach,
    originOf: (board) => (board === BOARD ? ORIGIN : undefined),
    report: () => {},
  });
  return { sent, reachOn, relay };
}

const view = (
  escalation?: HomeFeedEscalation,
  over: Partial<RemoteBoardView> = {},
): RemoteBoardView => ({
  boardId: BOARD,
  boardName: 'Riverbend <b>board</b>',
  rows: [],
  dropped: 0,
  linksRefused: 0,
  reached: true,
  ...(escalation ? { escalation } : {}),
  ...over,
});
const DEAD: HomeFeedEscalation = { deadSince: SINCE, stuck: 2, lead: 'agent-riverbend-lead' };

describe('a remote board’s escalation reaches Team Lead here', () => {
  it('sends ONE frame per dead stretch, on the board Team Lead holds, with no remote words', () => {
    const { sent, relay } = setup();
    relay.observe([view(DEAD)], NOW);
    relay.observe([view(DEAD)], NOW + 60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.on).toBe('w-harbour');
    expect(sent[0]?.to).toBe(TEAM_LEAD);
    expect(sent[0]?.frame).toEqual({
      event: STALL_EVENT,
      workspaceId: BOARD,
      escalatedFrom: 'agent-riverbend-lead',
      remote: { origin: ORIGIN, deadSince: SINCE, stuck: 2 },
      ts: NOW,
    });
    // The board's name is the remote's own text; it never rides the frame.
    expect(JSON.stringify(sent[0]?.frame)).not.toContain('Riverbend <b>');
  });

  it('tells again when the board dies again, and forgets a board that came back', () => {
    const { sent, relay } = setup();
    relay.observe([view(DEAD)], NOW);
    relay.observe([view()], NOW + 60_000);
    relay.observe([view({ ...DEAD, deadSince: SINCE + 3 * 60 * 60_000 })], NOW + 4 * 60 * 60_000);
    expect(sent.map((s) => s.frame.remote.deadSince)).toEqual([SINCE, SINCE + 3 * 60 * 60_000]);
  });

  it('a board the Mac could not reach keeps its record and tells nothing new', () => {
    const { sent, relay } = setup();
    relay.observe([view(DEAD)], NOW);
    // Unreached: the last rows read are kept, escalation included. That is
    // not the board dying again.
    relay.observe([view(DEAD, { reached: false })], NOW + 60_000);
    relay.observe([view(undefined, { reached: false })], NOW + 120_000);
    relay.observe([view(DEAD)], NOW + 180_000);
    expect(sent).toHaveLength(1);
  });

  it('with Team Lead on no board here, sends nothing and tries again on the next pass', () => {
    const { sent, reachOn, relay } = setup();
    reachOn.clear();
    relay.observe([view(DEAD)], NOW);
    expect(sent).toHaveLength(0);
    reachOn.add('w-harbour');
    relay.observe([view(DEAD)], NOW + 60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.frame.ts).toBe(NOW + 60_000);
  });

  it('a board missing from the routing table is never reported', () => {
    const { sent, relay } = setup();
    relay.observe([view(DEAD, { boardId: 'w-saltmarsh' })], NOW);
    expect(sent).toHaveLength(0);
  });

  it('names no lead when the feed named none', () => {
    const { sent, relay } = setup();
    relay.observe([view({ deadSince: SINCE, stuck: 1 })], NOW);
    expect(sent[0]?.frame.escalatedFrom).toBeUndefined();
  });
});
