import { afterEach, describe, expect, it } from 'vitest';
import { type DetailHandlers } from '../src/board/board-detail-render.ts';
import {
  type BoardGoal,
  type BoardTask,
  archivedTasks,
  boardSections,
  goalLabel,
  isTaskArchived,
  taskVisible,
} from '../src/board/board-model.ts';
import { describeEvent } from '../src/board/board-presence-model.ts';
import { type ArchivedViewHandlers, renderArchivedList } from '../src/board/board-render.ts';
import { disposeBoards, renderBoard } from './support/board.ts';
import { renderTaskDetail } from './support/task-detail.ts';

// The board is a mounted island now, not a call that returns; every mount
// holds a live subscription to the module-level signal until it is disposed.
afterEach(disposeBoards);

/**
 * The browser half of archiving a task.
 *
 * The server hides archived rows from every LISTING; the projection
 * deliberately does not hide them from the BOARD STATE, because the Undo
 * toast, the "N archived" count and the restore list all read the same
 * projected rows the lanes do. So the browser is where "off the board" is
 * actually decided, and these tests pin that in both directions — an archived
 * row leaves the lanes, and a restored one comes back — because a filter that
 * only ever hides is a board that has silently lost work.
 *
 * Fixtures are synthetic.
 */

function task(over: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 't1',
    title: 'Wire the index',
    status: 'todo',
    assignee: 'Search Revamp',
    goal: 'g1',
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: 'task:t1',
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

const FILTERS = { tab: 'all' as const, userName: 'Bryan', doneWindow: 'all' as const, now: 1000 };
const GOALS = [{ id: 'g1', title: '1. Ship it' }];

describe('archived rows and the board', () => {
  it('isTaskArchived reads the stamp, and asks nothing about the clock', () => {
    expect(isTaskArchived(task())).toBe(false);
    expect(isTaskArchived(task({ archivedAt: 500 }))).toBe(true);
    // A park expires; an archive does not. A stamp far in the past is still
    // archived, which is the difference from `isTaskParked`.
    expect(isTaskArchived(task({ archivedAt: 1 }))).toBe(true);
  });

  it('taskVisible drops an archived row and keeps an ordinary one', () => {
    expect(taskVisible(task({ archivedAt: 500 }), FILTERS)).toBe(false);
    expect(taskVisible(task(), FILTERS)).toBe(true); // positive control
  });

  it('an archived row leaves its lane, and a restore puts it back', () => {
    const live = task({ id: 't-live', title: 'Still here' });
    const gone = task({ id: 't-gone', title: 'Archived', archivedAt: 500 });
    const withArchived = boardSections(GOALS, [live, gone], FILTERS);
    const ids = withArchived.flatMap((s) => s.tasks.map((t) => t.id));
    expect(ids).toContain('t-live');
    expect(ids).not.toContain('t-gone');

    // The same row with the stamp cleared — which is exactly what the server
    // projects after a restore, since the refresh deletes absent keys.
    const restored = task({ id: 't-gone', title: 'Archived' });
    const after = boardSections(GOALS, [live, restored], FILTERS);
    expect(after.flatMap((s) => s.tasks.map((t) => t.id))).toContain('t-gone');
  });

  it('archivedTasks lists only archived rows, newest removal first', () => {
    const rows = archivedTasks([
      task({ id: 'a', archivedAt: 100 }),
      task({ id: 'b' }),
      task({ id: 'c', archivedAt: 900 }),
    ]);
    expect(rows.map((t) => t.id)).toEqual(['c', 'a']);
  });

  it('the trail says who archived what, and why', () => {
    const line = describeEvent(
      {
        event: 'task.archived',
        taskId: 't1',
        title: 'Wire the index',
        reason: 'duplicate of the index row',
        actor: { name: 'Bryan', kind: 'person' },
        ts: 1,
      } as unknown as Parameters<typeof describeEvent>[0],
      () => 'unused',
    );
    expect(line).toBe('Bryan archived “Wire the index” — duplicate of the index row');
    const back = describeEvent(
      {
        event: 'task.restored',
        taskId: 't1',
        title: 'Wire the index',
        actor: { name: 'Bryan', kind: 'person' },
        ts: 2,
      } as unknown as Parameters<typeof describeEvent>[0],
      () => 'unused',
    );
    expect(back).toBe('Bryan restored “Wire the index”');
  });
});

describe('the board foot line', () => {
  const handlers = {
    onStatusSet: () => {},
    onGoalTitleCommit: () => {},
    onOpenTask: () => {},
    onReorder: () => {},
    onTitleCommit: () => {},
    onAssign: () => {},
  };

  it('draws the archived count and opens the list', () => {
    const el = document.createElement('div');
    let opened = 0;
    renderBoard(el, boardSections(GOALS, [task()], FILTERS), {
      ...handlers,
      archivedCount: 3,
      onShowArchived: () => {
        opened += 1;
      },
    });
    const link = el.querySelector<HTMLButtonElement>('.board-foot-archived');
    expect(link?.textContent).toBe('3 archived');
    link?.click();
    expect(opened).toBe(1);
  });

  it('sits at the BOTTOM of the board, after the last band and the goal-add row', () => {
    // Bryan, 2026-08-29 (by voice, on the board): the archived link at the
    // top "is taking out space" — "if you want to find archive tasks, add it
    // somewhere at the bottom". Nothing above the first goal but the goals.
    const el = document.createElement('div');
    renderBoard(el, boardSections(GOALS, [task()], FILTERS), {
      ...handlers,
      archivedCount: 2,
      onShowArchived: () => {},
      onGoalAdd: () => {},
    });
    const foot = el.querySelector<HTMLElement>('.board-foot');
    const sections = [...el.querySelectorAll<HTMLElement>('.board-section')];
    const goalAdd = el.querySelector<HTMLElement>('.board-goal-add');
    // Positive controls: everything the foot is asserted to follow is there.
    expect(foot).not.toBeNull();
    expect(sections.length).toBeGreaterThan(0);
    expect(goalAdd).not.toBeNull();
    const follows = (a: Element, b: Element): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    for (const section of sections) expect(follows(section, foot as Element)).toBe(true);
    expect(follows(goalAdd as Element, foot as Element)).toBe(true);
    // And nothing at all above the first band: the old top slot is empty.
    expect(sections[0]?.previousElementSibling).toBeNull();
  });

  it('draws nothing at all when the board has archived nothing', () => {
    const el = document.createElement('div');
    renderBoard(el, boardSections(GOALS, [task()], FILTERS), {
      ...handlers,
      archivedCount: 0,
      onShowArchived: () => {},
    });
    expect(el.querySelector('.board-foot')).toBeNull();
    // Positive control: the same call with a count DOES draw one.
    renderBoard(el, boardSections(GOALS, [task()], FILTERS), {
      ...handlers,
      archivedCount: 1,
      onShowArchived: () => {},
    });
    expect(el.querySelector('.board-foot')).not.toBeNull();
  });
});

describe('the restore list', () => {
  function fixture(tasks: BoardTask[]) {
    const el = document.createElement('div');
    const restored: string[] = [];
    const opened: string[] = [];
    let back = 0;
    const handlers: ArchivedViewHandlers = {
      onRestore: (t) => restored.push(t.id),
      onOpenTask: (t) => opened.push(t.id),
      onBack: () => {
        back += 1;
      },
    };
    renderArchivedList(el, tasks, handlers);
    return { el, restored, opened, backCount: () => back };
  }

  it('draws one row per archived task, with who and why, and restores it', () => {
    const { el, restored } = fixture([
      task({ id: 't-a', title: 'Duplicate row', archivedAt: 900, archivedBy: 'Bryan' }),
    ]);
    const row = el.querySelector<HTMLElement>('.board-archived-row');
    expect(row?.dataset.taskId).toBe('t-a');
    expect(el.querySelector('.board-archived-title')?.textContent).toBe('Duplicate row');
    expect(el.querySelector('.board-archived-why')?.textContent).toContain('by Bryan');
    el.querySelector<HTMLButtonElement>('.board-archived-restore')?.click();
    expect(restored).toEqual(['t-a']);
  });

  it('shows the reason when there is one', () => {
    const { el } = fixture([
      task({ id: 't-a', archivedAt: 900, archivedBy: 'Bryan', archiveReason: 'not doing this' }),
    ]);
    expect(el.querySelector('.board-archived-why')?.textContent).toContain('not doing this');
  });

  it('says so when nothing is archived, rather than rendering an empty list', () => {
    const { el } = fixture([]);
    expect(el.querySelector('.board-archived-list')).toBeNull();
    expect(el.querySelector('.board-section-empty')?.textContent).toContain('Nothing archived');
  });

  it('offers the way back to the board', () => {
    const { el, backCount } = fixture([task({ id: 't-a', archivedAt: 900 })]);
    el.querySelector<HTMLButtonElement>('.board-archived-back')?.click();
    expect(backCount()).toBe(1);
  });
});

describe('the detail panel', () => {
  const base: DetailHandlers = {
    onClose: () => {},
    onStatusSet: () => {},
    onTitleCommit: () => {},
    onAnswer: () => undefined,
    onAssign: () => {},
  };

  function render(t: BoardTask, over: Partial<DetailHandlers>): HTMLElement {
    const el = document.createElement('div');
    renderTaskDetail(el, t, { ...base, ...over });
    return el;
  }

  it('puts Archive in the head actions of a live task', () => {
    const el = render(task(), { onArchive: () => {} });
    const btn = el.querySelector<HTMLButtonElement>(
      '.board-detail-head-actions .board-detail-archive',
    );
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toContain('Archive');
  });

  it('the head button archives the task it is drawn for', () => {
    const archived: string[] = [];
    const el = render(task({ id: 't-x' }), { onArchive: (t) => archived.push(t.id) });
    el.querySelector<HTMLButtonElement>('.board-detail-archive')?.click();
    expect(archived).toEqual(['t-x']);
  });

  it('an archived task gets Restore instead, plus a note saying who and why', () => {
    const restored: string[] = [];
    const el = render(
      task({ id: 't-x', archivedAt: 900, archivedBy: 'Bryan', archiveReason: 'obsolete' }),
      { onArchive: () => {}, onRestore: (t) => restored.push(t.id) },
    );
    const head = el.querySelector<HTMLButtonElement>('.board-detail-archive');
    expect(head?.getAttribute('aria-label')).toContain('Restore');
    const note = el.querySelector<HTMLElement>('.board-archived-note');
    expect(note?.textContent).toContain('Bryan');
    expect(note?.textContent).toContain('obsolete');
    note?.querySelector<HTMLButtonElement>('.board-archived-restore')?.click();
    expect(restored).toEqual(['t-x']);
  });

  it('draws no archived note on a live task', () => {
    const el = render(task(), { onArchive: () => {} });
    expect(el.querySelector('.board-archived-note')).toBeNull();
  });

  it('draws no archive control at all when the caller passes no handler', () => {
    const el = render(task(), {});
    expect(el.querySelector('.board-detail-archive')).toBeNull();
    // Positive control: the close button is there either way, so the query
    // above is looking at a panel that really rendered.
    expect(el.querySelector('.board-detail-close')).not.toBeNull();
  });
});

/**
 * The Goal picker on a ticket, when the board has archived bands.
 *
 * Filing is a phone action somebody repeats several times in a sitting, so the
 * list has to be short and in the order the board works. Only the SHORT half was ever
 * broken: the picker already walked `goals[]`, which is priority order, but it
 * walked all of it — on a board with six archived bands out of fifteen, a
 * third of the list was a choice that could only be wrong, which is what put
 * the band a ticket belongs to below a screenful of dead ones.
 *
 * The order is pinned here anyway, against `boardSections` — the board's own
 * answer to "which bands, in what order" — because the fix routes the picker
 * through that same filter, and a future sort applied to one and not the other
 * is exactly the drift the reader would see as the panel disagreeing with the
 * board behind it.
 */
describe('the goal picker', () => {
  const base: DetailHandlers = {
    onClose: () => {},
    onStatusSet: () => {},
    onTitleCommit: () => {},
    onAnswer: () => undefined,
    onAssign: () => {},
  };

  // Priority order deliberately disagrees with every order a list could fall
  // into by accident: the top band's title sorts LAST alphabetically, and the
  // archived band sits between the two live ones rather than at either end.
  const BANDS: BoardGoal[] = [
    { id: 'g-now', title: 'Zebra migration' },
    { id: 'g-old', title: 'Archived push', archivedAt: 500 },
    { id: 'g-next', title: 'Alpha rollout' },
  ];

  function picker(t: BoardTask, over: Partial<DetailHandlers> = {}): HTMLSelectElement {
    const el = document.createElement('div');
    renderTaskDetail(el, t, {
      ...base,
      goals: BANDS,
      goalLabel: (id) => goalLabel(BANDS, id),
      ...over,
    });
    return el.querySelector('.board-detail-goal') as HTMLSelectElement;
  }

  it('offers the live bands only, in the order the board works them', () => {
    const sel = picker(task({ goal: 'g-now' }));
    expect([...sel.options].map((o) => o.value)).toEqual(['g-now', 'g-next']);
    // The same answer the board itself gives — one source, not two copies.
    const bands = boardSections(BANDS, [], FILTERS)
      .filter((s) => !s.isChores && !s.isScheduled)
      .map((s) => s.id);
    expect([...sel.options].map((o) => o.value)).toEqual(bands);
    // The archived band was HANDED to the panel and is simply not offered:
    // the same fixture, asked for the ticket standing on that band, does draw
    // it (the case below), so the list above is a filter rather than a fixture
    // that never carried it.
    expect([...picker(task({ goal: 'g-old' })).options].map((o) => o.value)).toContain('g-old');
  });

  it('keeps a ticket standing on an archived band on it, saying so', () => {
    const sel = picker(task({ goal: 'g-old' }));
    // The assignment survives opening the picker: nothing else is selected,
    // so a save from here cannot silently move the ticket.
    expect(sel.value).toBe('g-old');
    // And the option SAYS so, so the closed control — which is all a phone
    // shows until the sheet is opened — does not read as an ordinary band.
    const opt = [...sel.querySelectorAll('option')].find((o) => o.value === 'g-old');
    expect(opt?.textContent).toBe('Archived push (archived)');
    // And it is BELOW the live bands rather than mixed in with them.
    expect([...sel.querySelectorAll('option')].map((o) => o.value)).toEqual([
      'g-now',
      'g-next',
      'g-old',
    ]);
  });

  it('moves a ticket off an archived band onto a live one', () => {
    const moved: Array<[string, string]> = [];
    const sel = picker(task({ id: 't-x', goal: 'g-old' }), {
      onGoalSet: (t, goalId) => moved.push([t.id, goalId]),
    });
    sel.value = 'g-next';
    sel.dispatchEvent(new Event('change'));
    expect(moved).toEqual([['t-x', 'g-next']]);
  });

  it('says nothing about archives when the ticket sits on a live band', () => {
    const sel = picker(task({ goal: 'g-now' }));
    expect([...sel.options].map((o) => o.textContent)).toEqual([
      'Zebra migration',
      'Alpha rollout',
    ]);
    // Positive control: the same picker DOES say it for the ticket that needs
    // it, so the assertion above is measuring the ticket and not the label.
    expect([...picker(task({ goal: 'g-old' })).options].map((o) => o.textContent)).toContain(
      'Archived push (archived)',
    );
  });
});
