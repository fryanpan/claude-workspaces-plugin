/**
 * The wake path on a REAL task store with an injected clock
 * (`task-scheduled-wake.ts` on the scheduler's pass). What is asserted is
 * what the pass sends and what it leaves on the rule: one addressed frame to
 * an attached owner carrying the instance id, ONE spawn request for a
 * detached one, attempts bounded with backoff, and one review item on the
 * instance once the last attempt has gone unanswered — plus the answer
 * recorded when somebody takes the row.
 *
 * Anchored at the wall clock for the reason task-scheduler-run-record.test.ts
 * is: a transition stamps `Date.now()`. Fixtures are invented; the repo is
 * public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TaskReviewItem, isReviewItemOpen, reviewWithdrawn } from '@claude-workspaces/core';
import { WAKE_BACKOFF_MS, WAKE_MAX_ATTEMPTS } from '@claude-workspaces/core/schedule-wake';
import { Identities } from '../src/identities.ts';
import {
  SCHEDULED_RUN_EVENT,
  SPAWN_REQUESTED_EVENT,
  type ScheduledRunFrame,
  type SpawnRequestedFrame,
  observeScheduledWake,
} from '../src/task-scheduled-wake.ts';
import { SCHEDULER_ACTOR, createTaskScheduler } from '../src/task-scheduler.ts';
import { TaskStore } from '../src/tasks.ts';
import { DAY, OWNER, instancesOf, seed } from './task-scheduler-seed.ts';

const MINUTE = 60_000;
const SPAWNER = 'agent-harbourmaster-lead';

type Sent = {
  workspaceId: string;
  agentId: string;
  frame: ScheduledRunFrame | SpawnRequestedFrame;
};

describe('waking the owner of a scheduled run', () => {
  let dataDir: string;
  let store: TaskStore;
  let sent: Sent[];
  /** Who holds a stream, per board. */
  let attached: Map<string, Set<string>>;
  const T0 = Date.now() - DAY - MINUTE;
  const DAILY = { rule: { kind: 'every' as const, everyMs: DAY }, armedAt: T0 };
  const FIRST = T0 + DAY;

  const build = (now: () => number) =>
    createTaskScheduler(store, {
      now,
      report: () => {},
      observers: [
        observeScheduledWake(
          store,
          {
            canReach: (ws, id) => attached.get(ws)?.has(id) ?? false,
            send: (workspaceId, agentId, frame) => {
              sent.push({ workspaceId, agentId, frame });
              return 1;
            },
            spawnerAgentId: SPAWNER,
            report: () => {},
          },
          SCHEDULER_ACTOR,
        ),
      ],
    });

  /** Seed, with the owner on the roster so the instance resolves to an id. */
  const seedKnown = () => {
    const seeded = seed(store, DAILY);
    store.attachAgent(seeded.workspaceId, {
      agentId: OWNER.id,
      agentName: OWNER.name,
      runtime: 'claude-code-local',
    });
    return seeded;
  };

  const openItems = (taskId: string): TaskReviewItem[] =>
    store.listReviewItems(taskId).filter((i) => isReviewItemOpen(i) && !reviewWithdrawn(i.review));

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-scheduled-wake-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    // The roster is what turns an owner NAME on a row into the agent id a
    // frame is addressed to; unwired, every row resolves to nobody.
    store.setAgentRoster(new Identities({ dataDir }));
    sent = [];
    attached = new Map();
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('sends an attached owner one frame naming the instance, and records the answer', () => {
    const { workspaceId, ruleId } = seedKnown();
    attached.set(workspaceId, new Set([OWNER.id]));
    let now = FIRST + MINUTE;
    const scheduler = build(() => now);
    scheduler.tick();
    const [instance] = instancesOf(store, workspaceId, ruleId);
    if (!instance) throw new Error('no instance');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      workspaceId,
      agentId: OWNER.id,
      frame: { event: SCHEDULED_RUN_EVENT, taskId: instance.id, ruleId, attempt: 1 },
    });
    // Inside the backoff: nothing more.
    now += MINUTE;
    scheduler.tick();
    expect(sent).toHaveLength(1);
    // The owner takes it. The next pass records who, and stops.
    store.transition(instance.id, 'in-progress', { actor: OWNER });
    now = Date.now() + MINUTE;
    scheduler.tick();
    const wake = store.getTask(ruleId)?.schedule?.state?.wake;
    expect(wake?.instanceId).toBe(instance.id);
    expect(wake?.answeredAt).toBeDefined();
    expect(wake?.answeredBy).toBe(OWNER.name);
    const notes = (store.getTask(ruleId)?.notes ?? []).map((n) => n.text);
    expect(notes.some((t) => t.startsWith('Wake answered'))).toBe(true);
    now += 10 * DAY;
    // Long after: still one frame, no item. (A new day fires a new instance
    // whose wake is its own, so count only frames for the first.)
    scheduler.tick();
    expect(sent.filter((s) => s.frame.taskId === instance.id)).toHaveLength(1);
    expect(openItems(instance.id)).toHaveLength(0);
  });

  it('asks the spawner ONCE for a detached owner, on whichever board the spawner holds a stream', () => {
    const { workspaceId, ruleId } = seedKnown();
    const elsewhere = store.createWorkspace('Lead Desk');
    attached.set(elsewhere.id, new Set([SPAWNER]));
    let now = FIRST + MINUTE;
    const scheduler = build(() => now);
    scheduler.tick();
    const [instance] = instancesOf(store, workspaceId, ruleId);
    if (!instance) throw new Error('no instance');
    const spawns = () => sent.filter((s) => s.frame.event === SPAWN_REQUESTED_EVENT);
    expect(spawns()).toHaveLength(1);
    expect(spawns()[0]).toMatchObject({
      workspaceId: elsewhere.id,
      agentId: SPAWNER,
      frame: { workspaceId, taskId: instance.id, agentId: OWNER.id, agentName: OWNER.name },
    });
    // Every later attempt reaches nobody; the spawner is not asked again.
    for (const wait of WAKE_BACKOFF_MS) {
      now += wait;
      scheduler.tick();
    }
    expect(spawns()).toHaveLength(1);
    const wake = store.getTask(ruleId)?.schedule?.state?.wake;
    expect(wake?.attempts.map((a) => a.via)).toEqual(['spawner', 'nobody', 'nobody', 'nobody']);
    // The spawned session shows up and takes the row: answered.
    attached.set(workspaceId, new Set([OWNER.id]));
    store.transition(instance.id, 'in-progress', { actor: OWNER });
    now = Date.now() + MINUTE;
    scheduler.tick();
    expect(store.getTask(ruleId)?.schedule?.state?.wake?.answeredAt).toBeDefined();
  });

  it('bounds the attempts with backoff, then files ONE review item on the instance', () => {
    const { workspaceId, ruleId } = seedKnown();
    attached.set(workspaceId, new Set([OWNER.id]));
    let now = FIRST + MINUTE;
    const scheduler = build(() => now);
    scheduler.tick();
    const [instance] = instancesOf(store, workspaceId, ruleId);
    if (!instance) throw new Error('no instance');
    const frames = () => sent.filter((s) => s.frame.taskId === instance.id);
    // One attempt per backoff window, none inside it.
    for (const [i, wait] of WAKE_BACKOFF_MS.entries()) {
      now += wait - 1;
      scheduler.tick();
      expect(frames()).toHaveLength(i + 1);
      now += 1;
      scheduler.tick();
      expect(frames()).toHaveLength(i + 2);
    }
    expect(frames()).toHaveLength(WAKE_MAX_ATTEMPTS);
    expect(frames().map((s) => (s.frame as ScheduledRunFrame).attempt)).toEqual([1, 2, 3, 4]);
    expect(openItems(instance.id)).toHaveLength(0);
    // One more window unanswered: the item, on the instance, once.
    now += WAKE_BACKOFF_MS[WAKE_BACKOFF_MS.length - 1] ?? 0;
    scheduler.tick();
    scheduler.tick();
    expect(openItems(instance.id)).toHaveLength(1);
    const item = openItems(instance.id)[0];
    expect(item?.review.headline).toContain('Nobody picked up');
    expect(item?.review.detail).toContain(`?task=${instance.id}`);
    expect(store.getTask(ruleId)?.schedule?.state?.wake?.exhaustedItemId).toBe(item?.id ?? '');
    // A day on the rule fires again and the NEW instance gets a wake of its
    // own; the old one keeps its one item and never a fifth frame.
    now += DAY;
    scheduler.tick();
    expect(openItems(instance.id)).toHaveLength(1);
    expect(frames()).toHaveLength(WAKE_MAX_ATTEMPTS);
    const [, second] = instancesOf(store, workspaceId, ruleId);
    expect(store.getTask(ruleId)?.schedule?.state?.wake?.instanceId).toBe(second?.id ?? '');
  });

  it('records nothing for a row its owner took before any wake was owed', () => {
    const { workspaceId, ruleId } = seedKnown();
    let now = FIRST + MINUTE;
    const scheduler = build(() => now);
    scheduler.tick();
    const [instance] = instancesOf(store, workspaceId, ruleId);
    if (!instance) throw new Error('no instance');
    // Nobody reachable, one attempt to nobody, then the owner takes it.
    store.transition(instance.id, 'done', { actor: OWNER });
    now = Date.now() + MINUTE;
    scheduler.tick();
    const wake = store.getTask(ruleId)?.schedule?.state?.wake;
    expect(wake?.attempts.map((a) => a.via)).toEqual(['nobody']);
    expect(wake?.answeredAt).toBeDefined();
    expect(sent).toHaveLength(0);
  });
});
