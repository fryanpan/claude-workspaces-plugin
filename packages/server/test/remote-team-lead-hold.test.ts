/**
 * Team Lead on another server holds a dead board, so the board's own server
 * does not ask its owner: the rule in stall-detection.md, Team Lead first and
 * the owner only when Team Lead cannot be reached.
 *
 * Three pieces, each driven directly with its clock passed in: the board's
 * side (`StallEscalations`: the grace a followed board waits, the hold a word
 * from the Mac buys, the item it withdraws, and the lapse), who counts as
 * following (`HomeFeedFollowers`), and the Mac's side (`RemoteEscalations`:
 * the word is sent once Team Lead has heard, repeated while it stays
 * reachable, and never sent when it is not). The two-server proof is
 * `remote-escalation-across-servers.test.ts`.
 *
 * All fixtures are synthetic — invented names. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FOLLOW_READ_WINDOW_MS, HomeFeedFollowers } from '../src/home-feed-followers.ts';
import type { RemoteBoardView } from '../src/home-remotes.ts';
import {
  REMOTE_ACK_REFRESH_MS,
  RemoteEscalations,
  type RemoteReach,
} from '../src/remote-escalations.ts';
import { REMOTE_ACK_GRACE_MS, REMOTE_HOLD_MS, StallEscalations } from '../src/stall-escalation.ts';
import type { StallSnapshot } from '../src/stall-nudge.ts';
import { type Task, TaskStore } from '../src/tasks.ts';

const AGENT = { id: 'agent-tide-runner', name: 'Tide Runner', kind: 'agent' };
const ESCALATE_MS = 60 * 60_000;

describe('the board’s side: Team Lead elsewhere holds it', () => {
  let dataDir: string;
  let store: TaskStore;
  let wsId: string;
  let task: Task;
  let now: number;
  let followed: boolean;

  const build = () =>
    new StallEscalations({
      store,
      dataDir,
      escalateMs: ESCALATE_MS,
      report: () => {},
      feedFollowed: () => followed,
    });
  const dead = (): StallSnapshot => ({
    workspaceId: wsId,
    leadAgentId: AGENT.id,
    retired: false,
    sessionLive: false,
    stalled: [{ id: task.id, title: task.title, bucket: 'in-progress', quietMs: 2 * ESCALATE_MS }],
    unfiled: [],
    considered: 1,
    undetermined: [],
  });
  const open = () =>
    store
      .listReviewItems(task.id)
      .filter((i) => i.answer === undefined && i.review.withdrawnAt === undefined);

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'remote-hold-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    wsId = store.createWorkspace('Tide board').id;
    const created = store.createTask(wsId, { title: 'Rank by recency', assignee: AGENT.name });
    if (!created.ok) throw new Error(created.error);
    task = created.task;
    now = Date.now() + 10 * 60_000;
    followed = true;
  });
  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a board nobody follows files at once', () => {
    followed = false;
    build().onBoard(dead(), now);
    expect(open()).toHaveLength(1);
  });

  it('a followed board waits out the grace, then files when no word came', () => {
    const e = build();
    e.onBoard(dead(), now);
    e.onBoard(dead(), now + REMOTE_ACK_GRACE_MS - 1);
    expect(open()).toHaveLength(0);
    e.onBoard(dead(), now + REMOTE_ACK_GRACE_MS);
    expect(open()).toHaveLength(1);
  });

  it('a word for this stretch keeps the item off, and lapses after the hold', () => {
    const e = build();
    e.onBoard(dead(), now);
    const since = e.deadBoard(wsId)?.deadSince as number;
    expect(e.holdByRemoteTeamLead(wsId, since, now + 1000)).toBe(true);
    e.onBoard(dead(), now + REMOTE_ACK_GRACE_MS + 1);
    e.onBoard(dead(), now + 1000 + REMOTE_HOLD_MS - 1);
    expect(open()).toHaveLength(0);
    // The feed still carries the escalation, so the Mac keeps repeating it.
    expect(e.deadBoard(wsId)?.deadSince).toBe(since);
    e.onBoard(dead(), now + 1000 + REMOTE_HOLD_MS);
    expect(open()).toHaveLength(1);
  });

  it('withdraws an item that already stands when the word comes', () => {
    followed = false;
    const e = build();
    e.onBoard(dead(), now);
    expect(open()).toHaveLength(1);
    const since = e.deadBoard(wsId)?.deadSince as number;
    expect(e.holdByRemoteTeamLead(wsId, since, now + 1000)).toBe(true);
    e.onBoard(dead(), now + 2000);
    expect(open()).toHaveLength(0);
    expect(store.listReviewItems(task.id)[0]?.review.withdrawnAt).toBeDefined();
  });

  it('ignores a word about another stretch, or a board that is not dead', () => {
    const e = build();
    expect(e.holdByRemoteTeamLead(wsId, now, now)).toBe(false);
    e.onBoard(dead(), now);
    const since = e.deadBoard(wsId)?.deadSince as number;
    expect(e.holdByRemoteTeamLead(wsId, since - 1, now + 1000)).toBe(false);
    e.onBoard(dead(), now + REMOTE_ACK_GRACE_MS);
    expect(open()).toHaveLength(1);
  });
});

describe('who follows a board’s feed', () => {
  it('a holder of the stream, or a reader inside the window', () => {
    let t = 1_000_000;
    const f = new HomeFeedFollowers(() => t);
    expect(f.followed('w-tide')).toBe(false);
    const close = f.opened('w-tide');
    expect(f.followed('w-tide')).toBe(true);
    close();
    close();
    expect(f.followed('w-tide')).toBe(false);
    f.read('w-tide');
    t += FOLLOW_READ_WINDOW_MS - 1;
    expect(f.followed('w-tide')).toBe(true);
    t += 1;
    expect(f.followed('w-tide')).toBe(false);
  });
});

describe('the Mac’s side: telling the board Team Lead has it', () => {
  const BOARD = 'w-riverbend';
  const SINCE = Date.UTC(2026, 10, 20, 9);
  const view: RemoteBoardView = {
    boardId: BOARD,
    boardName: 'Riverbend',
    rows: [],
    dropped: 0,
    linksRefused: 0,
    reached: true,
    escalation: { deadSince: SINCE, stuck: 1 },
  };
  const setup = () => {
    const reachOn = new Set(['w-harbour']);
    const acks: Array<[string, number]> = [];
    const reach: RemoteReach = {
      agentId: 'agent-harbour-master',
      boards: () => ['w-harbour'],
      canReach: (ws) => reachOn.has(ws),
      send: (on) => (reachOn.has(on) ? 1 : 0),
    };
    const relay = new RemoteEscalations({
      teamLead: reach,
      originOf: () => 'riverbend-origin.harborlight.test',
      acknowledge: async (board, deadSince) => {
        acks.push([board, deadSince]);
        return true;
      },
      report: () => {},
    });
    return { reachOn, acks, relay };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('sends the word once Team Lead heard, and again only after the refresh', async () => {
    const { acks, relay } = setup();
    const t = SINCE + ESCALATE_MS;
    relay.observe([view], t);
    await settle();
    expect(acks).toEqual([[BOARD, SINCE]]);
    relay.observe([view], t + REMOTE_ACK_REFRESH_MS - 1);
    await settle();
    expect(acks).toHaveLength(1);
    relay.observe([view], t + REMOTE_ACK_REFRESH_MS);
    await settle();
    expect(acks).toHaveLength(2);
  });

  it('sends no word while Team Lead cannot be reached here', async () => {
    const { reachOn, acks, relay } = setup();
    reachOn.clear();
    relay.observe([view], SINCE + ESCALATE_MS);
    await settle();
    expect(acks).toEqual([]);
  });

  it('stops repeating it once Team Lead goes', async () => {
    const { reachOn, acks, relay } = setup();
    const t = SINCE + ESCALATE_MS;
    relay.observe([view], t);
    await settle();
    reachOn.clear();
    relay.observe([view], t + REMOTE_ACK_REFRESH_MS);
    await settle();
    expect(acks).toHaveLength(1);
  });
});
