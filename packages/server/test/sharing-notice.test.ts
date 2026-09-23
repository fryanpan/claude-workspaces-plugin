/**
 * The owner's notice on its own, against fake store verbs. The route-level
 * behaviour, on a real server, is the "owner's notice" block of
 * `sharing-switch.test.ts`; this file pins what that one cannot reach
 * cheaply: a restart keeps the standing task and the open item, so it neither
 * files a second task nor strands an item it should withdraw.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharingFlip } from '../src/share/sharing-flip.ts';
import { SharingNotice, type SharingNoticeDeps, sharingOffReview } from '../src/sharing-notice.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fakeStore(dataDir: string) {
  const tasks = new Map<string, { id: string }>();
  const open = new Map<string, { taskId: string; review: unknown }>();
  const log: string[] = [];
  let n = 0;
  const deps: SharingNoticeDeps = {
    dataDir,
    boardId: () => 'w-unfiled',
    getTask: (id) => tasks.get(id),
    createTask: (ws) => {
      const task = { id: `t-${++n}` };
      tasks.set(task.id, task);
      log.push(`create ${ws} ${task.id}`);
      return { ok: true, task };
    },
    addReviewItem: (taskId, review) => {
      const id = `r-${++n}`;
      open.set(id, { taskId, review });
      log.push(`add ${taskId} ${id}`);
      return { ok: true, item: { id } };
    },
    withdrawReviewItem: (_taskId, itemId) => {
      open.delete(itemId);
      log.push(`withdraw ${itemId}`);
      return { ok: true };
    },
    refresh: () => {},
    announce: (_taskId, itemId) => log.push(`announce ${itemId}`),
    say: (line) => log.push(line),
  };
  return { deps, tasks, open, log };
}

const flip = (enabled: boolean, extra: Partial<SharingFlip> = {}): SharingFlip => ({
  enabled,
  actor: 'agent Bob',
  peer: '127.0.0.1',
  reason: 'review',
  at: Date.UTC(2026, 8, 23),
  ...extra,
});

describe('SharingNotice', () => {
  it('files and announces one item on off, and withdraws it on on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notice-'));
    dirs.push(dir);
    const s = fakeStore(dir);
    const notice = new SharingNotice(s.deps);
    notice.onFlip(flip(false));
    expect(s.open.size).toBe(1);
    expect(s.log).toEqual(['create w-unfiled t-1', 'add t-1 r-2', 'announce r-2']);
    notice.onFlip(flip(true));
    expect(s.open.size).toBe(0);
  });

  it('ignores a flip of one board', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notice-board-'));
    dirs.push(dir);
    const s = fakeStore(dir);
    new SharingNotice(s.deps).onFlip(flip(false, { workspaceId: 'w-harbor' }));
    expect(s.log).toEqual([]);
  });

  it('reuses the task and withdraws the open item across a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notice-restart-'));
    dirs.push(dir);
    const s = fakeStore(dir);
    new SharingNotice(s.deps).onFlip(flip(false));
    const after = new SharingNotice(s.deps);
    after.onFlip(flip(false, { reason: 'again' }));
    expect(s.tasks.size).toBe(1);
    expect(s.open.size).toBe(1);
    new SharingNotice(s.deps).onFlip(flip(true));
    expect(s.open.size).toBe(0);
  });
});

describe('sharingOffReview', () => {
  it('names who, where, when and why', () => {
    const review = sharingOffReview(flip(false)) as { detail: string; review_type: string };
    expect(review.review_type).toBe('question');
    expect(review.detail).toContain('agent Bob');
    expect(review.detail).toContain('127.0.0.1');
    expect(review.detail).toContain('2026-09-23T00:00:00.000Z');
    expect(review.detail).toContain('review');
  });
});
