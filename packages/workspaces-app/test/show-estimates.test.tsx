/**
 * "Show estimates", the board's half: off unless the board says on, and off
 * means no goal strip and no Hands-on / Wall clock fields (Bryan, 1 Nov:
 * "hide all estimation stuff on all screens behind that setting").
 *
 * Each case pairs the hidden reading with the shown one on the same rows, so
 * an empty reading means the setting hid something, not that the fixture had
 * nothing to show.
 *
 * All fixtures are synthetic.
 */
import { EFFORT_ESTIMATE_PROMPT_VERSION } from '@claude-workspaces/core/effort-estimate-prompt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { BoardState } from '../src/board/board-actions.ts';
import { type DetailHandlers, detailFields } from '../src/board/board-detail-render.ts';
import {
  type BoardGoal,
  type BoardTask,
  DEFAULT_DONE_WINDOW,
  boardSectionsForReader,
} from '../src/board/board-model.ts';
import { createBoardProjection, initialBoardState } from '../src/board/board-projection.ts';
import { parseBoardLocation } from '../src/board/board-url.ts';
import { mountShowEstimates } from '../src/board/show-estimates.ts';
import { disposeBoards, renderBoard } from './support/board.ts';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const GOALS: BoardGoal[] = [{ id: 'g-harbor', title: 'Open the Harborlight route' }];

let seq = 0;
function task(overrides: Partial<BoardTask> = {}): BoardTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Riverbend task ${seq}`,
    status: 'todo',
    assignee: 'Alice',
    goal: 'g-harbor',
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW,
    effortEstimate: {
      status: 'ok',
      handsOnSeconds: 600,
      wallClockSeconds: 3600,
      promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION,
    },
    ...overrides,
  };
}

const filters = { doneWindow: DEFAULT_DONE_WINDOW, now: NOW };

describe('the goal strip', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => {
    disposeBoards();
    host.remove();
  });

  const paint = (show: boolean): void => {
    const rows = [task(), task()];
    renderBoard(host, boardSectionsForReader(GOALS, rows, filters, NOW, show), {} as never);
  };

  it('is drawn when the board shows estimates', () => {
    paint(true);
    expect(host.querySelector('.board-goal-effort')).not.toBeNull();
  });

  it('is not drawn when it does not, and the band itself still is', () => {
    paint(false);
    // Positive control: the band and its rows rendered.
    expect(host.textContent).toContain('Open the Harborlight route');
    expect(host.querySelector('.board-goal-effort')).toBeNull();
    expect(host.textContent).not.toMatch(/Hands-on|Projected|finish|not scored/);
  });
});

describe('the task panel’s fields', () => {
  const labels = (show: boolean): string[] =>
    [
      ...detailFields(task(), {} as DetailHandlers, undefined, 'g-harbor', show).querySelectorAll(
        'dt',
      ),
    ].map((dt) => dt.textContent ?? '');

  it('carries Hands-on and Wall clock when the board shows estimates', () => {
    expect(labels(true)).toEqual(expect.arrayContaining(['Hands-on', 'Wall clock']));
  });

  it('carries neither when it does not, and keeps the rest', () => {
    const shown = labels(false);
    expect(shown).toContain('Goal');
    expect(shown).not.toContain('Hands-on');
    expect(shown).not.toContain('Wall clock');
  });
});

describe('the projection read', () => {
  const readWith = (fields: Record<string, unknown>): BoardState => {
    const doc = new Y.Doc();
    const ws = doc.getMap('workspace');
    for (const [k, v] of Object.entries(fields)) ws.set(k, v);
    const state = initialBoardState(parseBoardLocation('/workspaces/ws-1', ''));
    createBoardProjection({
      state,
      workspaceId: 'ws-1',
      document,
      maps: () => ({ tasks: doc.getMap('tasks'), ws }),
    }).readProjection();
    return state;
  };

  it('reads no setting on a board that never set it', () => {
    const state = readWith({ id: 'ws-1', name: 'Saltmarsh', goals: [] });
    expect(state.info?.name).toBe('Saltmarsh');
    expect(state.info?.showEstimates).not.toBe(true);
  });

  it('reads it on when the board doc says so', () => {
    expect(
      readWith({ id: 'ws-1', name: 'Saltmarsh', showEstimates: true }).info?.showEstimates,
    ).toBe(true);
  });
});

describe('the settings row', () => {
  const setup = (opts: { canEdit: boolean; ok?: boolean }) => {
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    const write = vi.fn(async () => opts.ok ?? true);
    const toast = vi.fn();
    const row = mountShowEstimates({ toggle, canEdit: () => opts.canEdit, write, toast });
    return { toggle, write, toast, row };
  };

  it('follows the board, and an owner turning it on writes true', async () => {
    const { toggle, write, row } = setup({ canEdit: true });
    row.paint(false);
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(true));
    // Another page turned it off: the row follows without being touched.
    row.paint(false);
    expect(toggle.checked).toBe(false);
  });

  it('puts the box back and says so when the write is refused', async () => {
    const { toggle, toast, row } = setup({ canEdit: true, ok: false });
    row.paint(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toggle.checked).toBe(false);
  });

  it('is shown but not offered to a reader who cannot change it', () => {
    const { toggle, row } = setup({ canEdit: false });
    row.paint(true);
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
  });
});
