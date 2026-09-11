/**
 * The board half of the unfiled-ask judgement: has this agent put its ask
 * anywhere the owner reads, and who are the people on this board?
 *
 * Both answers come out of one walk of the open tasks, and both are read by
 * the Stop-hook note route. The cases that earn their runtime are the ones
 * where the walk could plausibly answer yes and must not: somebody else's
 * item, a withdrawn one, a finished ticket, a name nobody is.
 *
 * Fixtures are synthetic and the agent names are invented. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/tasks.ts';
import { filingStateFor } from '../src/unfiled-ask-filing.ts';

const RIVERBEND = { id: 'agent-riverbend', name: 'Riverbend', kind: 'known' };
const HARBORLIGHT = { id: 'agent-harborlight', name: 'Harborlight', kind: 'known' };
const OWNER = { id: 'known-quill', name: 'Quill', kind: 'person' };

const ask = {
  shape: 'decision' as const,
  headline: 'Which cut shape ships first?',
  detail: 'Both shapes answer the same request; shipping both doubles the review surface.',
  options: [
    { id: 'o-1a2b', label: 'Round' },
    { id: 'o-3c4d', label: 'Square' },
  ],
};

describe('filingStateFor', () => {
  let dir: string;
  let store: TaskStore;
  let ws: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'unfiled-ask-filing-'));
    store = new TaskStore({ dataDir: dir, debounceMs: 1 });
    ws = store.createWorkspace('Board').id;
  });
  afterEach(() => {
    store.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A task with one review item filed by `actor`, and the item's id. */
  function filed(actor: { id: string; name: string; kind?: string }): {
    taskId: string;
    itemId: string;
  } {
    const created = store.createTask(ws, { title: 'Cut shape', assignee: actor.name, actor });
    if (!created.ok) throw new Error(`create refused: ${created.error}`);
    const added = store.addReviewItem(created.task.id, ask, { actor });
    if (!added.ok) throw new Error(`add refused: ${added.error}`);
    return { taskId: created.task.id, itemId: added.item.id };
  }

  it('sees nothing on an empty board', () => {
    expect(filingStateFor(store, ws, 'Riverbend', 0)).toEqual({
      openItem: false,
      filedSince: false,
      owners: [],
    });
  });

  it("sees an agent's own open item, and does not see somebody else's", () => {
    filed(RIVERBEND);
    expect(filingStateFor(store, ws, 'Riverbend', 0).openItem).toBe(true);
    expect(filingStateFor(store, ws, 'riverbend  ', 0).openItem).toBe(true);
    expect(filingStateFor(store, ws, 'Harborlight', 0).openItem).toBe(false);
  });

  it('separates "filed at some point" from "filed this turn"', () => {
    const { itemId } = filed(RIVERBEND);
    const at = store.listReviewItems(store.findReviewItem(itemId)?.taskId ?? '')[0]?.createdAt ?? 0;
    expect(filingStateFor(store, ws, 'Riverbend', at)).toMatchObject({
      openItem: true,
      filedSince: true,
    });
    expect(filingStateFor(store, ws, 'Riverbend', at + 1)).toMatchObject({
      openItem: true,
      filedSince: false,
    });
  });

  it('stops counting an item the agent withdrew', () => {
    const { taskId, itemId } = filed(RIVERBEND);
    const gone = store.withdrawReviewItem(taskId, itemId, { actor: RIVERBEND, reason: 'answered' });
    expect(gone.ok).toBe(true);
    expect(filingStateFor(store, ws, 'Riverbend', 0).openItem).toBe(false);
  });

  it('stops counting an item on a finished ticket', () => {
    const { taskId } = filed(RIVERBEND);
    for (const to of ['in-progress', 'done'] as const) {
      const moved = store.transition(taskId, to, { actor: RIVERBEND });
      if (!moved.ok) throw new Error(`transition to ${to} refused: ${moved.error}`);
    }
    expect(filingStateFor(store, ws, 'Riverbend', 0).openItem).toBe(false);
  });

  it('names the people who have moved a task, and no agent', () => {
    const { taskId } = filed(RIVERBEND);
    store.transition(taskId, 'in-progress', { actor: HARBORLIGHT });
    expect(filingStateFor(store, ws, 'Riverbend', 0).owners).toEqual([]);
    store.transition(taskId, 'todo', { actor: OWNER });
    expect(filingStateFor(store, ws, 'Riverbend', 0).owners).toEqual(['Quill']);
  });

  it('still names a person whose tasks are all finished', () => {
    // The filing check stops at open tasks — a done task's item is on nobody's
    // queue. Who the PEOPLE are does not stop there: somebody whose last
    // transition closed a ticket is still the person a wait names.
    const { taskId } = filed(RIVERBEND);
    store.transition(taskId, 'in-progress', { actor: OWNER });
    store.transition(taskId, 'done', { actor: OWNER });
    const state = filingStateFor(store, ws, 'Riverbend', 0);
    expect(state.openItem).toBe(false);
    expect(state.owners).toEqual(['Quill']);
  });

  it('names each person once however many tasks they touched', () => {
    for (let i = 0; i < 3; i++) {
      const { taskId } = filed(RIVERBEND);
      store.transition(taskId, 'in-progress', { actor: OWNER });
      store.transition(taskId, 'todo', { actor: OWNER });
    }
    expect(filingStateFor(store, ws, 'Riverbend', 0).owners).toEqual(['Quill']);
  });
});
