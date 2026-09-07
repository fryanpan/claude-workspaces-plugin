/**
 * The run record on a REAL task store with an injected clock
 * (`task-run-record.ts` on the scheduler's pass). What is asserted is what
 * the pass leaves on the board: the success recorded on the rule with a
 * line naming the instance, ONE review item while a rule is stale however
 * many ticks pass, its withdrawal when a run succeeds, and no second item
 * against a silence the reader has already answered.
 *
 * The clock is injected, but anchored at the wall clock: a status transition
 * stamps `Date.now()` on the instance, and the record reads that stamp as the
 * success, so a fixture in March would read every close as months in the
 * future. An interval rule armed "now" has no calendar to disagree with.
 * Fixtures are invented; the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TaskReviewItem, isReviewItemOpen, reviewWithdrawn } from '@claude-workspaces/core';
import { staleAfterMs } from '@claude-workspaces/core/schedule-run-record';
import { createTaskScheduler } from '../src/task-scheduler.ts';
import { TaskStore } from '../src/tasks.ts';
import { DAY, HOUR, OWNER, instancesOf, seed } from './task-scheduler-seed.ts';

const PERSON = { id: 'user-harbourmaster', name: 'Harbourmaster', kind: 'known' } as const;

describe('the run record on a scheduled row', () => {
  let dataDir: string;
  let store: TaskStore;
  /** Armed a day and a minute ago, so the first occurrence is a minute ago
   *  and a close stamped by the wall clock lands after the fire. */
  const T0 = Date.now() - DAY - 60_000;
  const DAILY = { rule: { kind: 'every' as const, everyMs: DAY }, armedAt: T0 };
  /** The first occurrence. */
  const FIRST = T0 + DAY;

  const openItems = (ruleId: string): TaskReviewItem[] =>
    store.listReviewItems(ruleId).filter((i) => isReviewItemOpen(i) && !reviewWithdrawn(i.review));

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-scheduler-run-record-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('records the success on the rule, with one line naming where the work landed', () => {
    const { workspaceId, ruleId } = seed(store, DAILY);
    let now = FIRST + 60_000;
    const scheduler = createTaskScheduler(store, { now: () => now, report: () => {} });
    scheduler.tick();
    const [instance] = instancesOf(store, workspaceId, ruleId);
    if (!instance) throw new Error('no instance');
    store.transition(instance.id, 'done', { actor: OWNER });
    now = FIRST + 2 * HOUR;
    expect(store.getTask(ruleId)?.schedule?.state?.lastSuccessAt).toBeUndefined();
    scheduler.tick();
    const state = store.getTask(ruleId)?.schedule?.state;
    expect(state?.lastSuccessAt).toBeDefined();
    const notes = store.getTask(ruleId)?.notes ?? [];
    const finished = notes.filter((n) => n.text.startsWith('Run finished'));
    expect(finished).toHaveLength(1);
    expect(finished[0]?.text).toContain(instance.id);
    // The next tick has nothing new to say: one success, one line.
    scheduler.tick();
    expect(
      (store.getTask(ruleId)?.notes ?? []).filter((n) => n.text.startsWith('Run finished')),
    ).toHaveLength(1);
  });

  it('files ONE review item while the rule is stale, not one per tick, and withdraws it on success', () => {
    const { workspaceId, ruleId } = seed(store, DAILY);
    let now = FIRST + 60_000;
    const scheduler = createTaskScheduler(store, { now: () => now, report: () => {} });
    scheduler.tick();
    const [first] = instancesOf(store, workspaceId, ruleId);
    if (!first) throw new Error('no instance');
    // Nobody closes it. A day and change later the rule is owed a success it
    // never got.
    now = T0 + staleAfterMs(DAY) + 60_000;
    scheduler.tick();
    expect(openItems(ruleId)).toHaveLength(1);
    const item = openItems(ruleId)[0];
    expect(item?.review.headline).toContain('has not succeeded');
    expect(item?.review.detail).toContain(`?task=${first.id}`);
    // Ten more ticks, a day apart: still the one item.
    for (let i = 0; i < 10; i++) {
      now += DAY;
      scheduler.tick();
    }
    expect(openItems(ruleId)).toHaveLength(1);
    expect(openItems(ruleId)[0]?.id).toBe(item?.id ?? '');
    // A run closes. The item goes, and the rule says so on its record.
    const latest = instancesOf(store, workspaceId, ruleId).at(-1);
    if (!latest) throw new Error('no latest instance');
    store.transition(latest.id, 'done', { actor: OWNER });
    // The close is stamped by the wall clock; read the record just after it.
    now = Date.now() + 60_000;
    scheduler.tick();
    expect(openItems(ruleId)).toHaveLength(0);
    const filed = store.listReviewItems(ruleId).find((i) => i.id === item?.id);
    expect(filed && reviewWithdrawn(filed.review)).toBe(true);
    expect(store.getTask(ruleId)?.schedule?.state?.staleItem).toBeUndefined();
  });

  it('does not refile an item the reader answered until the rule has succeeded and gone stale again', () => {
    const { workspaceId, ruleId } = seed(store, DAILY);
    let now = T0 + staleAfterMs(DAY) + 60_000;
    const scheduler = createTaskScheduler(store, { now: () => now, report: () => {} });
    scheduler.tick();
    const [item] = openItems(ruleId);
    if (!item) throw new Error('no stale item');
    const answered = store.answerTaskReview(ruleId, item.id, 'Looking into it', {
      actor: PERSON,
    });
    expect(answered.ok).toBe(true);
    for (let i = 0; i < 5; i++) {
      now += DAY;
      scheduler.tick();
    }
    expect(openItems(ruleId)).toHaveLength(0);
    expect(store.listReviewItems(ruleId)).toHaveLength(1);
    // The rule succeeds, then goes quiet for another stretch: a NEW item.
    const latest = instancesOf(store, workspaceId, ruleId).at(-1);
    if (!latest) throw new Error('no instance');
    store.transition(latest.id, 'done', { actor: OWNER });
    now = Date.now() + 60_000;
    scheduler.tick();
    // The close was stamped by the wall clock, so the next stretch of silence
    // is measured from there.
    now = Date.now() + staleAfterMs(DAY) + 60_000;
    scheduler.tick();
    expect(openItems(ruleId)).toHaveLength(1);
    expect(store.listReviewItems(ruleId)).toHaveLength(2);
  });

  it('never calls a one-off stale, however long its instance sits open', () => {
    const { ruleId } = seed(store, { rule: { kind: 'once', at: FIRST }, armedAt: T0 });
    let now = FIRST + 60_000;
    const scheduler = createTaskScheduler(store, { now: () => now, report: () => {} });
    scheduler.tick();
    now = FIRST + 30 * DAY;
    scheduler.tick();
    expect(openItems(ruleId)).toHaveLength(0);
  });
});
