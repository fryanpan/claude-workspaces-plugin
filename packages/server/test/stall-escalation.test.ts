/**
 * The board going past its lead — on liveness, and on nothing else.
 *
 * The ticket's criterion, verbatim: "a live lead with a row waiting on Bryan
 * produces no item; a dead lead produces one addressed to Team Lead." So the
 * two facts this suite pins are the trigger (no live session on the board,
 * for the whole window) and the addressee order (Team Lead first, the reader
 * only when Team Lead is unreachable too). It drives `StallEscalations`
 * directly against a real `TaskStore`, because the thing under test is what
 * lands on a reader's queue — one item, revised as the set moves, withdrawn
 * the tick anybody is back, and never a second one.
 *
 * Every clock is passed in (`now`) rather than waited for: the module takes
 * the tick's time as an argument, so an hour is a number here and no test
 * sleeps.
 *
 * All fixtures are synthetic — invented names. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskReviewItems } from '../src/review-queue.ts';
import {
  STALL_ESCALATION_FILENAME,
  StallEscalations,
  type TeamLeadReach,
  boardDeadFor,
  buildStallEscalationReview,
} from '../src/stall-escalation.ts';
import type { StalledRow } from '../src/stall-gate.ts';
import {
  STALL_EVENT,
  type StallNudgeFrame,
  StallNudger,
  type StallSnapshot,
} from '../src/stall-nudge.ts';
import { type Task, TaskStore } from '../src/tasks.ts';

const PERSON = { id: 'known-robin', name: 'Robin Vale', kind: 'person' };
const AGENT = { id: 'agent-tide-runner', name: 'Tide Runner', kind: 'agent' };
const TEAM_LEAD = 'agent-harbour-master';
const ESCALATE_MS = 60 * 60_000;

function row(task: Task, bucket: string, quietMs = 90 * 60_000): StalledRow {
  return { id: task.id, title: task.title, bucket, quietMs };
}

/** A board nobody has been on for longer than the window, unless a test says
 *  otherwise: no live session, no heartbeat, no agent write. */
function board(workspaceId: string, parts: Partial<StallSnapshot> = {}): StallSnapshot {
  return {
    workspaceId,
    leadAgentId: AGENT.id,
    retired: false,
    sessionLive: false,
    stalled: [],
    unfiled: [],
    considered: 4,
    undetermined: [],
    ...parts,
  };
}

describe('when a board is dead', () => {
  it('a live session is alive whatever the clocks say', () => {
    const now = 10_000_000;
    expect(boardDeadFor({ sessionLive: true }, now, ESCALATE_MS)).toBeUndefined();
    expect(
      boardDeadFor({ sessionLive: true, agentActiveAt: now - 5 * ESCALATE_MS }, now, ESCALATE_MS),
    ).toBeUndefined();
  });

  it('a write or a heartbeat inside the window is alive; outside it is dead', () => {
    const now = 10_000_000;
    expect(
      boardDeadFor({ sessionLive: false, agentActiveAt: now - ESCALATE_MS + 1 }, now, ESCALATE_MS),
    ).toBeUndefined();
    expect(
      boardDeadFor(
        { sessionLive: false, sessionObservedAt: now - ESCALATE_MS + 1 },
        now,
        ESCALATE_MS,
      ),
    ).toBeUndefined();
    expect(
      boardDeadFor({ sessionLive: false, agentActiveAt: now - ESCALATE_MS }, now, ESCALATE_MS),
    ).toBe(ESCALATE_MS);
  });

  it('a board nobody has ever been on is dead from its first tick', () => {
    expect(boardDeadFor({ sessionLive: false }, 10_000_000, ESCALATE_MS)).toBe(ESCALATE_MS);
  });
});

describe('a dead board escalates; a live one never does', () => {
  let dataDir: string;
  let store: TaskStore;
  let wsId: string;
  let now: number;
  /** What Team Lead was sent, per board it was reached on. */
  let sent: Array<{ on: string; to: string; frame: StallNudgeFrame }>;
  /** Boards Team Lead can be reached on. */
  let reachOn: Set<string>;

  const teamLead = (): TeamLeadReach => ({
    agentId: TEAM_LEAD,
    boards: () => store.listWorkspaces().map((w) => w.id),
    canReach: (ws, id) => id === TEAM_LEAD && reachOn.has(ws),
    send: (on, to, frame) => {
      sent.push({ on, to, frame });
      return 1;
    },
  });
  const build = (opts: { withTeamLead?: boolean } = {}) =>
    new StallEscalations({
      store,
      dataDir,
      escalateMs: ESCALATE_MS,
      report: () => {},
      ...(opts.withTeamLead === false ? {} : { teamLead: teamLead() }),
    });

  const make = (title: string): Task => {
    const created = store.createTask(wsId, { title, assignee: AGENT.name });
    if (!created.ok) throw new Error(`create failed: ${created.error}`);
    return created.task;
  };
  const items = (taskId: string) => store.listReviewItems(taskId);
  const openItems = (taskId: string) =>
    items(taskId).filter((i) => i.answer === undefined && i.review.withdrawnAt === undefined);
  /**
   * What the READER's queue actually shows, through the same function Home
   * builds it with. Open is not the same as visible: `taskReviewItems` drops
   * a done ticket's rows and a withdrawn item, so an item can be open
   * forever and reach nobody.
   */
  const queued = () =>
    taskReviewItems(
      store.listTasks(wsId).map((t) => ({
        id: t.id,
        title: t.title,
        bodyDocId: `task:${t.id}`,
        done: t.status === 'done',
        reviews: store.listReviewItems(t.id),
      })),
    );

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'stall-escalation-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    wsId = store.createWorkspace('Tide board').id;
    now = Date.now() + 10 * 60_000;
    sent = [];
    reachOn = new Set();
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('the trigger', () => {
    it('a live lead with a row waiting on a person produces nothing, however long', () => {
      const a = make('Choose the retention window');
      const escalations = build();
      const waiting = {
        id: a.id,
        title: a.title,
        waitingOn: [{ kind: 'task' as const, taskId: a.id, reviewItemId: 'r-1' }],
      };
      for (let hours = 0; hours < 30; hours += 1) {
        escalations.onBoard(
          board(wsId, { sessionLive: true, waiting: [waiting] }),
          now + hours * ESCALATE_MS,
        );
      }
      expect(items(a.id)).toHaveLength(0);
      expect(sent).toHaveLength(0);
    });

    it('a live lead with STUCK rows produces nothing either — the wake is its addressee', () => {
      const a = make('Split the parser out of the loader');
      const escalations = build();
      const rows = { unfiled: [row(a, 'blocked-on-owner-unfiled', 9 * ESCALATE_MS)] };
      escalations.onBoard(board(wsId, { sessionLive: true, ...rows }), now);
      escalations.onBoard(
        board(wsId, { sessionLive: false, agentActiveAt: now - ESCALATE_MS / 2, ...rows }),
        now,
      );
      escalations.onBoard(
        board(wsId, { sessionLive: false, sessionObservedAt: now - ESCALATE_MS / 2, ...rows }),
        now,
      );
      expect(items(a.id)).toHaveLength(0);
      expect(sent).toHaveLength(0);
    });

    it('a dead board with a row waiting on a person, and nothing stuck, produces nothing', () => {
      const a = make('Choose the retention window');
      build().onBoard(
        board(wsId, {
          waiting: [
            {
              id: a.id,
              title: a.title,
              waitingOn: [{ kind: 'task', taskId: a.id, reviewItemId: 'r-1' }],
            },
          ],
        }),
        now,
      );
      expect(items(a.id)).toHaveLength(0);
      expect(sent).toHaveLength(0);
    });

    it('does not escalate a minute before the window, and does at it', () => {
      const a = make('Land the backfill');
      const escalations = build({ withTeamLead: false });
      const last = now - ESCALATE_MS;
      escalations.onBoard(
        board(wsId, { agentActiveAt: last + 60_000, stalled: [row(a, 'in-progress')] }),
        now,
      );
      expect(items(a.id)).toHaveLength(0);
      escalations.onBoard(
        board(wsId, { agentActiveAt: last, stalled: [row(a, 'in-progress')] }),
        now,
      );
      expect(openItems(a.id)).toHaveLength(1);
    });

    it('a retired board escalates nothing, and takes back what it had filed', () => {
      const a = make('Archive the old importer');
      const escalations = build({ withTeamLead: false });
      escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), now);
      expect(openItems(a.id)).toHaveLength(1);
      escalations.onBoard(
        board(wsId, { retired: true, unfiled: [row(a, 'blocked-on-owner-unfiled')] }),
        now + 60_000,
      );
      expect(openItems(a.id)).toHaveLength(0);
      expect(items(a.id)[0]?.review.withdrawnAt).toBeDefined();
    });
  });

  describe('Team Lead first', () => {
    it('a dead lead produces a frame to Team Lead, on its own board, and no item', () => {
      const a = make('Rank results by recency');
      reachOn.add(wsId);
      build().onBoard(board(wsId, { stalled: [row(a, 'in-progress')] }), now);
      expect(items(a.id)).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        on: wsId,
        to: TEAM_LEAD,
        frame: {
          event: STALL_EVENT,
          workspaceId: wsId,
          taskId: a.id,
          title: a.title,
          stalledCount: 1,
          escalatedFrom: AGENT.id,
        },
      });
    });

    it('reaches Team Lead on ANOTHER board when it holds no stream on the dead one', () => {
      const a = make('Rank results by recency');
      const other = store.createWorkspace('Harbour board').id;
      reachOn.add(other);
      build().onBoard(board(wsId, { stalled: [row(a, 'in-progress')] }), now);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.on).toBe(other);
      // The frame still names the DEAD board: that is what Team Lead acts on.
      expect(sent[0]?.frame.workspaceId).toBe(wsId);
      expect(items(a.id)).toHaveLength(0);
    });

    it('tells Team Lead once per window while the board stays dead, not once per tick', () => {
      const a = make('Rank results by recency');
      reachOn.add(wsId);
      const escalations = build();
      const snapshot = board(wsId, { stalled: [row(a, 'in-progress')] });
      escalations.onBoard(snapshot, now);
      escalations.onBoard(snapshot, now + 60_000);
      escalations.onBoard(snapshot, now + ESCALATE_MS - 60_000);
      expect(sent).toHaveLength(1);
      escalations.onBoard(snapshot, now + ESCALATE_MS);
      expect(sent).toHaveLength(2);
    });

    it('a Team Lead that comes back mid-stretch takes over from the reader', () => {
      // Filed to the reader because nobody could be reached; then Team Lead
      // attaches somewhere. The reader's item is not withdrawn — the board is
      // still dead and the ask still stands — but nothing more is filed, and
      // Team Lead hears about it.
      const a = make('Rank results by recency');
      const escalations = build();
      const snapshot = board(wsId, { stalled: [row(a, 'in-progress')] });
      escalations.onBoard(snapshot, now);
      expect(openItems(a.id)).toHaveLength(1);
      expect(sent).toHaveLength(0);
      reachOn.add(wsId);
      escalations.onBoard(snapshot, now + 60_000);
      expect(sent).toHaveLength(1);
      expect(openItems(a.id)).toHaveLength(1);
    });
  });

  describe('the reader, when Team Lead is unreachable too', () => {
    it('files ONE item, on the unfiled row, naming every stuck row with a relative link', () => {
      const a = make('Choose the retention window');
      const b = make('Rank results by recency');
      const c = make('Write the migration');
      build().onBoard(
        board(wsId, {
          stalled: [row(b, 'in-progress', 3 * ESCALATE_MS), row(c, 'ready-unpicked')],
          unfiled: [row(a, 'blocked-on-owner-unfiled', 2 * ESCALATE_MS)],
        }),
        now,
      );
      expect(sent).toHaveLength(0);
      expect(openItems(a.id)).toHaveLength(1);
      expect(openItems(b.id)).toHaveLength(0);
      expect(openItems(c.id)).toHaveLength(0);
      const item = openItems(a.id)[0];
      expect(item?.createdBy).toBe('Claude Workspaces');
      const detail = item?.review.detail ?? '';
      for (const t of [a, b, c]) {
        expect(detail).toContain(`(/workspaces/${wsId}?task=${t.id})`);
        expect(detail).toContain(t.title);
      }
      expect(detail).not.toContain('http');
      expect(queued()).toHaveLength(1);
    });

    it('a second stuck row REVISES the same item rather than filing another', () => {
      const a = make('Choose the retention window');
      const b = make('Rank results by recency');
      const escalations = build({ withTeamLead: false });
      escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), now);
      escalations.onBoard(
        board(wsId, {
          unfiled: [row(a, 'blocked-on-owner-unfiled')],
          stalled: [row(b, 'in-progress')],
        }),
        now + 60_000,
      );
      expect(openItems(a.id)).toHaveLength(1);
      expect(items(b.id)).toHaveLength(0);
      expect(openItems(a.id)[0]?.review.detail ?? '').toContain(b.title);
      expect(queued()).toHaveLength(1);
    });

    it('withdraws the item the tick a session is on the board again', () => {
      const a = make('Choose the retention window');
      const escalations = build({ withTeamLead: false });
      const rows = { unfiled: [row(a, 'blocked-on-owner-unfiled')] };
      escalations.onBoard(board(wsId, rows), now);
      expect(openItems(a.id)).toHaveLength(1);
      // The row is exactly as stuck; the only change is that somebody is here.
      escalations.onBoard(board(wsId, { sessionLive: true, ...rows }), now + 60_000);
      expect(openItems(a.id)).toHaveLength(0);
      expect(items(a.id)[0]?.review.withdrawnAt).toBeDefined();
      expect(escalations.filedCount()).toBe(0);
    });

    it('withdraws the item when the rows it named are no longer stuck', () => {
      const a = make('Choose the retention window');
      const escalations = build({ withTeamLead: false });
      escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), now);
      escalations.onBoard(board(wsId), now + 60_000);
      expect(openItems(a.id)).toHaveLength(0);
      expect(queued()).toHaveLength(0);
    });

    it('a board that dies again files again, with no cooldown in the way', () => {
      const a = make('Choose the retention window');
      const escalations = build({ withTeamLead: false });
      const rows = { unfiled: [row(a, 'blocked-on-owner-unfiled')] };
      escalations.onBoard(board(wsId, rows), now);
      escalations.onBoard(board(wsId, { sessionLive: true, ...rows }), now + 60_000);
      expect(openItems(a.id)).toHaveLength(0);
      escalations.onBoard(board(wsId, rows), now + 120_000);
      expect(openItems(a.id)).toHaveLength(1);
      expect(items(a.id)).toHaveLength(2);
    });

    it('does not re-file for rows the reader has already answered about', () => {
      const a = make('Split the parser out of the loader');
      const b = make('Write the migration');
      const escalations = build({ withTeamLead: false });
      escalations.onBoard(board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }), now);
      const filed = openItems(a.id)[0]?.id ?? '';
      store.answerTaskReview(a.id, filed, 'Looking at it now', { actor: PERSON });

      // Still dead, still stuck; the reader has spoken about this row.
      escalations.onBoard(
        board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] }),
        now + 60_000,
      );
      expect(items(a.id)).toHaveLength(1);
      // A row they were NOT shown is new.
      escalations.onBoard(
        board(wsId, {
          unfiled: [row(a, 'blocked-on-owner-unfiled')],
          stalled: [row(b, 'in-progress')],
        }),
        now + 120_000,
      );
      expect(openItems(a.id)).toHaveLength(1);
      expect(openItems(a.id)[0]?.review.detail ?? '').toContain(b.title);
    });

    it('MOVES the item to a row that is still stuck when the anchor closes', () => {
      const a = make('Choose the retention window');
      const b = make('Rank results by recency');
      const escalations = build({ withTeamLead: false });
      escalations.onBoard(
        board(wsId, {
          unfiled: [row(a, 'blocked-on-owner-unfiled')],
          stalled: [row(b, 'in-progress')],
        }),
        now,
      );
      expect(openItems(a.id)).toHaveLength(1);
      store.transition(a.id, 'done', { actor: PERSON });
      // A done ticket's items are invisible to the reader; the board is still
      // dead and b is still stuck.
      escalations.onBoard(board(wsId, { stalled: [row(b, 'in-progress')] }), now + 60_000);
      expect(openItems(a.id)).toHaveLength(0);
      expect(openItems(b.id)).toHaveLength(1);
      expect(queued()).toHaveLength(1);
      expect(escalations.filedCount()).toBe(1);
    });

    it('a restart reads the sidecar and does not file a second item', () => {
      const a = make('Land the backfill');
      const snapshot = board(wsId, { unfiled: [row(a, 'blocked-on-owner-unfiled')] });
      build({ withTeamLead: false }).onBoard(snapshot, now);
      expect(openItems(a.id)).toHaveLength(1);
      expect(readFileSync(join(dataDir, STALL_ESCALATION_FILENAME), 'utf8')).toContain(a.id);

      const restarted = build({ withTeamLead: false });
      restarted.onBoard(snapshot, now + 60_000);
      restarted.onBoard(snapshot, now + 120_000);
      expect(openItems(a.id)).toHaveLength(1);
      expect(restarted.filedCount()).toBe(1);
    });

    it('a board with no Team Lead configured goes straight to the reader', () => {
      const a = make('Land the backfill');
      build({ withTeamLead: false }).onBoard(
        board(wsId, { stalled: [row(a, 'in-progress')] }),
        now,
      );
      expect(openItems(a.id)).toHaveLength(1);
    });
  });
});

describe('the escalation cannot take the stall loop down with it', () => {
  it('a filer that throws costs its own board and nothing else', () => {
    const seen: string[] = [];
    const boards: StallSnapshot[] = [board('ws-one'), board('ws-two')];
    const nudger = new StallNudger({
      snapshot: () => boards,
      canReach: () => false,
      send: () => 0,
      escalate: (b) => {
        seen.push(b.workspaceId);
        if (b.workspaceId === 'ws-one') throw new Error('sidecar is on fire');
      },
    });
    expect(() => nudger.tick()).not.toThrow();
    expect(seen).toEqual(['ws-one', 'ws-two']);
  });
});

describe('the words a reader sees', () => {
  const rows = [
    {
      id: 't-1',
      title: 'Choose the retention window',
      bucket: 'blocked-on-owner-unfiled',
      quietMs: 3 * 60 * 60_000,
    },
  ];

  it('names the row once, in plain words, with a relative link and the quiet span', () => {
    const review = buildStallEscalationReview({
      workspaceId: 'ws-1',
      rows,
      deadForMs: 2 * 60 * 60_000,
    });
    expect(review.review_type).toBe('question');
    expect(review.headline).toBe(
      'Nobody is on this board, and “Choose the retention window” is stuck',
    );
    const detail = String(review.detail);
    expect(detail).toContain('[Choose the retention window](/workspaces/ws-1?task=t-1)');
    expect(detail).toContain('waiting on a person, with no question filed anywhere they read');
    expect(detail).toContain('Quiet 3h');
    expect(detail).not.toContain('blocked-on-owner-unfiled');
  });

  it('says how long nobody has been here, and that Team Lead was tried', () => {
    const detail = String(
      buildStallEscalationReview({ workspaceId: 'ws-1', rows, deadForMs: 2 * 60 * 60_000 }).detail,
    );
    expect(detail).toContain('for over 2h');
    expect(detail).toContain('Team Lead could not be reached');
    expect(detail).toContain('withdraws on its own');
  });

  it('counts the rows in the headline when there is more than one', () => {
    const review = buildStallEscalationReview({
      workspaceId: 'ws-1',
      rows: [...rows, { id: 't-2', title: 'Rank results', bucket: 'in-progress', quietMs: 60_000 }],
      deadForMs: 60 * 60_000,
    });
    expect(review.headline).toBe('Nobody is on this board, and 2 tasks are stuck');
  });
});
