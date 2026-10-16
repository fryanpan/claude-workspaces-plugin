/**
 * The plan lead's ranks and feed, composed: a ticket's `review_item.added`
 * and a doc thread's declared item reach the lead in one frame, a person
 * moving a task voids the lead's earlier rank on it, and a rank on a board
 * the lead may not hear from never counts.
 *
 * Fixtures are invented; the repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Thread, WebhookPayload } from '@claude-workspaces/core';
import { ASK_WINDOW_MS, type AskFrame } from '../src/ask-feed.ts';
import type { CrossReviewItem } from '../src/cross-review-queue.ts';
import { wireLeadRanks } from '../src/lead-rank-wiring.ts';
import type { TaskStoreEvent } from '../src/tasks.ts';

const PLAN = 'w-saltmarsh';
const LEAD = 'agent-team-lead';
const NAMES: Record<string, string> = { 'w-harbor': 'Harborlight', 'w-river': 'Riverbend' };

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function wired(locked = new Set<string>()) {
  dir = mkdtempSync(join(tmpdir(), 'lead-rank-wiring-'));
  let now = 1_000_000;
  let pending: (() => void) | null = null;
  const listeners = new Set<(e: TaskStoreEvent) => void>();
  const sent: AskFrame[] = [];
  const w = wireLeadRanks({
    dataDir: dir,
    planBoard: () => PLAN,
    leadOf: (ws) => (ws === PLAN ? LEAD : undefined),
    boardName: (ws) => NAMES[ws],
    isOff: (place) => locked.has(place.workspaceId),
    taskWorkspace: (taskId) => (taskId === 't-ferry' ? 'w-river' : undefined),
    goalWorkspace: () => undefined,
    boardsForDoc: (docId) => (docId === 'd-tides' ? ['w-harbor'] : []),
    onTaskEvent: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    sendToAgent: (_ws, _agent, frame) => {
      sent.push(frame);
      return 1;
    },
    agentConnected: () => true,
    now: () => now,
    schedule: (fn) => {
      pending = fn;
      return () => {
        pending = null;
      };
    },
  });
  const emit = (e: TaskStoreEvent) => {
    for (const l of listeners) l(e);
  };
  const closeWindow = () => {
    now += ASK_WINDOW_MS;
    const fn = pending;
    pending = null;
    fn?.();
  };
  return { w, sent, emit, closeWindow, tick: (ms: number) => (now += ms) };
}

const added = (workspaceId: string, taskId: string, headline: string, ts: number) =>
  ({
    type: 'review_item.added',
    workspaceId,
    taskId,
    reviewItemId: 'r-1',
    shape: 'decision',
    headline,
    actor: { id: 'agent-river', name: 'Riverbend Agent', kind: 'agent' },
    links: [],
    ts,
  }) as TaskStoreEvent;

const docThread = (headline: string): WebhookPayload => {
  const comment = {
    id: 'c-1',
    author: { id: 'agent-harbor', name: 'Harborlight Agent' },
    text: 'Detail the lead never sees.',
    ts: 77,
    review: { shape: 'review', headline },
  };
  return {
    event: 'thread.created',
    docId: 'd-tides',
    threadId: 'th-1',
    thread: { id: 'th-1', comments: [comment] } as unknown as Thread,
    comment,
  } as unknown as WebhookPayload;
};

const item = (key: string, workspaceId: string, taskId: string): CrossReviewItem =>
  ({ key, workspaceId, kind: 'task-review', taskId, reviewItemId: 'r-1' }) as CrossReviewItem;

describe('wireLeadRanks', () => {
  it('sends a ticket ask and a doc-thread ask from two boards as one frame', () => {
    const { w, sent, emit, closeWindow } = wired();
    emit(added('w-river', 't-ferry', 'Ship the ferry times?', 10));
    w.onDocEvent('d-tides', docThread('Does the tide table read right?'));
    expect(sent).toHaveLength(0);
    closeWindow();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.items).toEqual([
      {
        workspaceId: 'w-river',
        board: 'Riverbend',
        row: { kind: 'task-review', taskId: 't-ferry', reviewItemId: 'r-1' },
        key: 'w-river:task-review:t-ferry:r-1',
        headline: 'Ship the ferry times?',
        createdAt: 10,
      },
      {
        workspaceId: 'w-harbor',
        board: 'Harborlight',
        row: { kind: 'doc-thread', docId: 'd-tides', threadId: 'th-1' },
        key: 'w-harbor:doc-thread:d-tides:th-1',
        headline: 'Does the tide table read right?',
        createdAt: 77,
      },
    ]);
    w.stop();
  });

  it('never sends an ask from a locked board', () => {
    const { w, sent, emit, closeWindow } = wired(new Set(['w-river']));
    emit(added('w-river', 't-ferry', 'Private ferry question', 10));
    closeWindow();
    expect(sent).toHaveLength(0);
    w.stop();
  });

  it('a person moving the task voids the lead’s earlier rank; an agent’s move does not', () => {
    const { w, emit, tick } = wired();
    const it1 = item('w-river:task-review:t-ferry:r-1', 'w-river', 't-ferry');
    w.ranks.set(it1.key, 2, LEAD);
    expect(w.leadRank(it1)).toBe(2);
    const regrouped = (kind: 'agent' | 'person', ts: number) =>
      ({
        type: 'task.regrouped',
        workspaceId: 'w-river',
        taskId: 't-ferry',
        fromGoal: 'g-1',
        toGoal: 'g-1',
        order: 0,
        actor: { id: kind === 'person' ? 'known-owner' : 'agent-river', name: 'x', kind },
        ts,
      }) as TaskStoreEvent;
    emit(regrouped('agent', 2_000_000));
    expect(w.leadRank(it1)).toBe(2);
    tick(5);
    emit(regrouped('person', 2_000_000));
    expect(w.leadRank(it1)).toBeUndefined();
    w.stop();
  });

  it('a rank on a board the lead may not hear from never counts', () => {
    const locked = new Set<string>();
    const { w } = wired(locked);
    const it1 = item('w-river:task-review:t-ferry:r-1', 'w-river', 't-ferry');
    w.ranks.set(it1.key, 1, LEAD);
    expect(w.leadRank(it1)).toBe(1);
    locked.add('w-river');
    expect(w.leadRank(it1)).toBeUndefined();
    w.stop();
  });
});
