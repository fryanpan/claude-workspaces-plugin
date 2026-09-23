/**
 * The owner's notice on its own, against fake store verbs. The route-level
 * behaviour, on a real server, is the "owner's notice" block of
 * `sharing-switch.test.ts`; this file pins what that one cannot reach
 * cheaply: a restart keeps the standing task and the open item, a repeat
 * flip revises rather than refiles, and who may turn the switch back on by
 * answering.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharingFlip } from '../src/share/sharing-flip.ts';
import {
  SHARING_LEAVE_OFF_OPTION,
  SHARING_ON_OPTION,
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

const OWNER = { id: 'known-owner', name: 'Owner', kind: 'person' };

function fakeStore(prefix: string) {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dataDir);
  const tasks = new Map<string, { id: string; workspaceId: string }>();
  const retired = new Set<string>();
  const live: string[] = [];
  const open = new Map<string, { taskId: string; review: { detail?: unknown } }>();
  const log: string[] = [];
  const flips: Array<{ actor: string; peer: string; reason: string }> = [];
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
    addReviewItem: (taskId, review) => {
      const id = `r-${++n}`;
      open.set(id, { taskId, review: review as { detail?: unknown } });
      log.push(`add ${taskId} ${id}`);
      return { ok: true, item: { id } };
    },
    reviseReviewItem: (_taskId, itemId, patch) => {
      const row = open.get(itemId);
      if (!row) return { ok: false };
      row.review = { ...row.review, ...patch };
      log.push(`revise ${itemId}`);
      return { ok: true };
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
    isOwner: (actor) => actor.id === OWNER.id,
    turnBackOn: (who) => {
      flips.push(who);
      return { ok: true };
    },
    say: (line) => log.push(line),
  };
  return { deps, tasks, open, log, flips, retired, live };
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

  it('revises the open item on a repeat off, so the queue holds one naming the latest flip', async () => {
    const s = fakeStore('notice-repeat-');
    const notice = new SharingNotice(s.deps);
    await notice.onFlip(flip(false));
    await notice.onFlip(flip(false, { reason: 'second look' }));
    expect(s.open.size).toBe(1);
    expect(s.log).toEqual([
      'create w-unfiled t-1',
      'add t-1 r-2',
      'gate r-2',
      'revise r-2',
      'gate r-2',
    ]);
    expect(String(s.open.get('r-2')?.review.detail)).toContain('second look');
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

  it('turns the switch back on when the owner answers Turn back on', async () => {
    const s = fakeStore('notice-answer-');
    const notice = new SharingNotice(s.deps);
    await notice.onFlip(flip(false));
    notice.onAnswered({
      taskId: 't-1',
      reviewItemId: 'r-2',
      optionId: SHARING_ON_OPTION,
      answer: 'Turn back on',
      actor: OWNER,
    });
    expect(s.flips).toHaveLength(1);
    expect(s.flips[0]?.actor).toBe('owner Owner (known-owner)');
    expect(notice.openItem()).toBeUndefined();
  });

  it('records Leave off, and a Turn back on from anyone but the owner, without flipping', async () => {
    const s = fakeStore('notice-refuse-');
    const notice = new SharingNotice(s.deps);
    await notice.onFlip(flip(false));
    notice.onAnswered({
      taskId: 't-1',
      reviewItemId: 'r-2',
      optionId: SHARING_LEAVE_OFF_OPTION,
      answer: 'Leave off',
      actor: OWNER,
    });
    expect(s.flips).toHaveLength(0);
    // A new item for the next flip, then an agent answering it.
    await notice.onFlip(flip(false));
    const item = notice.openItem();
    expect(item?.itemId).toBe('r-3');
    notice.onAnswered({
      taskId: 't-1',
      reviewItemId: 'r-3',
      optionId: SHARING_ON_OPTION,
      answer: 'Turn back on',
      actor: { id: 'agent-bob', name: 'Bob', kind: 'agent' },
    });
    expect(s.flips).toHaveLength(0);
    expect(s.log.at(-1)).toContain('not the owner');
  });

  it('ignores an answer to any other item', async () => {
    const s = fakeStore('notice-other-');
    const notice = new SharingNotice(s.deps);
    await notice.onFlip(flip(false));
    notice.onAnswered({
      taskId: 't-1',
      reviewItemId: 'r-99',
      optionId: SHARING_ON_OPTION,
      answer: 'Turn back on',
      actor: OWNER,
    });
    expect(s.flips).toHaveLength(0);
    expect(notice.openItem()?.itemId).toBe('r-2');
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
  it('names the intended, mistaken and incident readings, each with its option', () => {
    const { detail } = sharingOffReview(flip(false));
    expect(detail).toContain('Did you or one of your agents mean this?');
    expect(detail).toMatch(/\*\*Intended, for one board:\*\*[^\n]*Turn back on/);
    expect(detail).toMatch(/\*\*A mistake:\*\*[^\n]*older plugin[^\n]*Turn back on/);
    expect(detail).toMatch(/\*\*An incident:\*\*[^\n]*Leave off[^\n]*share list/);
  });

  it('names the unattributed caller the way the facts line does', () => {
    const { detail } = sharingOffReview(flip(false, { actor: 'unattributed' }));
    expect(detail.startsWith('An unnamed caller turned off sharing')).toBe(true);
    expect(detail).toContain('"An unnamed caller" is a program on this machine');
  });

  it('stays short enough to read on a phone', () => {
    const { detail } = sharingOffReview(
      flip(false, { actor: 'unattributed', reason: 'closing the Harborlight board' }),
    );
    expect(detail.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(120);
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
  it('is a decision naming who, where, when, why and what stays refused', () => {
    const review = sharingOffReview(flip(false));
    expect(review.review_type).toBe('decision');
    expect(review.headline).toBe('External sharing was turned off');
    expect(review.options.map((o) => o.label)).toEqual(['Turn back on', 'Leave off']);
    expect(review.detail).toContain('The agent Bob turned off');
    expect(review.detail).toContain('127.0.0.1, this machine');
    expect(review.detail).toContain('00:00 UTC on 23 September 2026');
    expect(review.detail).toContain('\u201creview\u201d');
    expect(review.detail).toContain(
      'every share-link, collaboration and public-hostname visitor is refused',
    );
  });
});
