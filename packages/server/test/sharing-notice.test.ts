/**
 * The owner's notice on its own, against fake store verbs. The route-level
 * behaviour, on a real server, is the "owner's notice" block of
 * `sharing-switch.test.ts`; this file pins what that one cannot reach
 * cheaply: a restart keeps the standing task and the open item, a repeat
 * flip revises rather than refiles, and the card is let go, not withdrawn,
 * when the access door turns the switch on from it. Who may answer it is the
 * door's (`share-door-holes.test.ts`, `sharing-switch.test.ts`).
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharingFlip } from '../src/share/sharing-flip.ts';
import {
  SHARING_NOTICE_FILENAME,
  SharingNotice,
  type SharingNoticeDeps,
  actorOnCard,
  rankFallbackBoards,
  sharingOffReview,
} from '../src/sharing-notice.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fakeStore(prefix: string) {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dataDir);
  const tasks = new Map<string, { id: string; workspaceId: string }>();
  const retired = new Set<string>();
  const live: string[] = [];
  const open = new Map<string, { taskId: string; change: unknown; review: { detail?: unknown } }>();
  const log: string[] = [];
  let n = 0;
  const deps: SharingNoticeDeps = {
    dataDir,
    boardId: () => 'w-unfiled',
    getTask: (id) => tasks.get(id),
    isBoardLive: (ws) => !retired.has(ws),
    fallbackBoards: () => live,
    createTask: (ws) => {
      if (retired.has(ws)) return { ok: false, error: 'workspace-retired' };
      const task = { id: `t-${++n}`, workspaceId: ws };
      tasks.set(task.id, task);
      log.push(`create ${ws} ${task.id}`);
      return { ok: true, task };
    },
    addAccessReviewItem: (taskId, change, why) => {
      const id = `r-${++n}`;
      open.set(id, { taskId, change, review: { detail: why } });
      log.push(`add ${taskId} ${id}`);
      return { ok: true, item: { id } };
    },
    withdrawReviewItem: (_taskId, itemId) => {
      open.delete(itemId);
      log.push(`withdraw ${itemId}`);
      return { ok: true };
    },
    refresh: () => {},
    gate: async (_taskId, itemId) => {
      log.push(`gate ${itemId}`);
    },
    say: (line) => log.push(line),
  };
  return { deps, tasks, open, log, retired, live };
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
  it('files one item on off and passes it through the gate, and withdraws it on on', async () => {
    const s = fakeStore('notice-');
    const notice = new SharingNotice(s.deps);
    await notice.onFlip(flip(false));
    expect(s.open.size).toBe(1);
    expect(s.log).toEqual(['create w-unfiled t-1', 'add t-1 r-2', 'gate r-2']);
    await notice.onFlip(flip(true));
    expect(s.open.size).toBe(0);
  });

  it('replaces the open card on a repeat off, so the queue holds one naming the latest flip', async () => {
    const s = fakeStore('notice-repeat-');
    const notice = new SharingNotice(s.deps);
    await notice.onFlip(flip(false));
    await notice.onFlip(flip(false, { reason: 'second look' }));
    expect(s.open.size).toBe(1);
    // An access card is never reworded: the old one goes, a new one names the latest flip.
    expect(s.log).toEqual([
      'create w-unfiled t-1',
      'add t-1 r-2',
      'gate r-2',
      'withdraw r-2',
      'add t-1 r-3',
      'gate r-3',
    ]);
    expect(String(s.open.get('r-3')?.review.detail)).toContain('second look');
  });

  it('files on a live board when the catch-all board is retired', async () => {
    const s = fakeStore('notice-retired-');
    s.retired.add('w-unfiled');
    s.live.push('w-harbor');
    await new SharingNotice(s.deps).onFlip(flip(false));
    expect(s.open.size).toBe(1);
    expect([...s.tasks.values()].map((t) => t.workspaceId)).toEqual(['w-harbor']);
  });

  it('leaves a standing task whose board was retired later, and files on a live one', async () => {
    const s = fakeStore('notice-retired-later-');
    s.live.push('w-harbor');
    const notice = new SharingNotice(s.deps);
    await notice.onFlip(flip(false));
    await notice.onFlip(flip(true));
    s.retired.add('w-unfiled');
    await notice.onFlip(flip(false));
    expect(notice.openItem()?.taskId).not.toBe('t-1');
    expect(s.tasks.get(notice.openItem()?.taskId ?? '')?.workspaceId).toBe('w-harbor');
  });

  it('says so when every board refuses', async () => {
    const s = fakeStore('notice-nowhere-');
    s.retired.add('w-unfiled');
    await new SharingNotice(s.deps).onFlip(flip(false));
    expect(s.open.size).toBe(0);
    expect(s.log.at(-1)).toContain('filed nowhere');
  });

  it('ignores a flip of one board', async () => {
    const s = fakeStore('notice-board-');
    await new SharingNotice(s.deps).onFlip(flip(false, { workspaceId: 'w-harbor' }));
    expect(s.log).toEqual([]);
  });

  it('reuses the task and the open item across a restart', async () => {
    const s = fakeStore('notice-restart-');
    await new SharingNotice(s.deps).onFlip(flip(false));
    await new SharingNotice(s.deps).onFlip(flip(false, { reason: 'again' }));
    expect(s.tasks.size).toBe(1);
    expect(s.open.size).toBe(1);
    await new SharingNotice(s.deps).onFlip(flip(true));
    expect(s.open.size).toBe(0);
  });

  it('files an access card that turns sharing on, on the board holding the notice', async () => {
    const s = fakeStore('notice-card-');
    const notice = new SharingNotice(s.deps);
    await notice.onFlip(flip(false));
    expect(s.open.get('r-2')?.change).toEqual({ op: 'sharing-on', workspaceId: 'w-unfiled' });
    expect(notice.openCard()).toEqual({ workspaceId: 'w-unfiled', taskId: 't-1', itemId: 'r-2' });
  });

  it('lets the card go, not withdrawn, when the door turns sharing on from it', async () => {
    const s = fakeStore('notice-door-');
    const notice = new SharingNotice(s.deps);
    await notice.onFlip(flip(false));
    const res = notice.turnOnFromCard(() => {
      void notice.onFlip(flip(true, { actor: 'owner Bryan' }));
      return { ok: true };
    });
    expect(res.ok).toBe(true);
    // Still on the store for the door to answer; no longer the notice's.
    expect(s.open.has('r-2')).toBe(true);
    expect(notice.openItem()).toBeUndefined();
    // Positive control: any other turn-on withdraws it.
    await notice.onFlip(flip(false));
    await notice.onFlip(flip(true));
    expect(s.log.at(-1)).toBe(`withdraw ${'r-3'}`);
  });

  it('forgets an item filed before the notice was a card, so the next flip files one', async () => {
    const s = fakeStore('notice-legacy-');
    s.tasks.set('t-0', { id: 't-0', workspaceId: 'w-unfiled' });
    writeFileSync(
      join(s.deps.dataDir, SHARING_NOTICE_FILENAME),
      JSON.stringify({ taskId: 't-0', itemId: 'r-old' }),
    );
    const notice = new SharingNotice(s.deps);
    expect(notice.openItem()).toBeUndefined();
    await notice.onFlip(flip(false));
    expect(s.log).not.toContain('withdraw r-old');
    expect(notice.openCard()?.taskId).toBe('t-0');
  });
});

describe('rankFallbackBoards', () => {
  it('drops retired boards, puts unshared first, then the most recently active', () => {
    expect(
      rankFallbackBoards([
        { id: 'w-old', retired: false, shared: false, activeAt: 1 },
        { id: 'w-shared', retired: false, shared: true, activeAt: 9 },
        { id: 'w-gone', retired: true, shared: false, activeAt: 10 },
        { id: 'w-new', retired: false, shared: false, activeAt: 5 },
      ]),
    ).toEqual(['w-new', 'w-old', 'w-shared']);
  });
});

describe('the card says how to decide', () => {
  // The real judge held the first prod card because it named what happened
  // and gave no way to decide. These three readings are that way; cutting one
  // must move a test.
  it('names the intended, mistaken and incident readings, each with its option and what to look at', () => {
    const { detail } = sharingOffReview(flip(false));
    expect(detail).toContain('To tell what happened, read the first line');
    expect(detail).toMatch(/\*\*Intended, for one board:\*\*[^\n]*Approve/);
    expect(detail).toMatch(/\*\*A mistake:\*\*[^\n]*older plugin[^\n]*Approve/);
    expect(detail).toMatch(/\*\*An incident:\*\*[^\n]*Reject[^\n]*share list/);
    // One observable per reading, so the reader can tell them apart.
    expect(detail).toMatch(
      /\*\*Intended, for one board:\*\* the caller is your agent and the reason names a board/,
    );
    expect(detail).toMatch(
      /\*\*A mistake:\*\* the caller is unnamed, or your agent gave no reason/,
    );
    expect(detail).toMatch(
      /\*\*An incident:\*\* the caller is nobody you know, or the address is not this machine/,
    );
  });

  it('names the unattributed caller the way the facts line does', () => {
    const { detail } = sharingOffReview(flip(false, { actor: 'unattributed' }));
    expect(detail.startsWith('An unnamed caller turned off sharing')).toBe(true);
    expect(detail).toContain('An unnamed caller is a program on this machine');
  });

  it('stays short enough to read on a phone', () => {
    const { detail } = sharingOffReview(
      flip(false, { actor: 'unattributed', reason: 'closing the Harborlight board' }),
    );
    expect(detail.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(160);
  });
});

describe('actorOnCard', () => {
  it('keeps the name and drops the id the log carries', () => {
    expect(actorOnCard('agent Bob (agent-bob)')).toBe('The agent Bob');
    expect(actorOnCard('person alice@saltmarsh.example')).toBe('alice@saltmarsh.example');
    expect(actorOnCard('unattributed')).toBe('An unnamed caller');
  });
});

describe('sharingOffReview', () => {
  it('names who, where, when, why and what stays refused', () => {
    const review = sharingOffReview(flip(false));
    expect(review.headline).toBe('External sharing was turned off');
    expect(review.detail).toContain('Approve turns it back on; Reject leaves it off.');
    expect(review.detail).toContain('The agent Bob turned off');
    expect(review.detail).toContain('127.0.0.1, this machine');
    expect(review.detail).toContain('00:00 UTC on 23 September 2026');
    expect(review.detail).toContain('\u201creview\u201d');
    expect(review.detail).toContain(
      'every share-link, collaboration and public-hostname visitor is refused',
    );
  });
});
