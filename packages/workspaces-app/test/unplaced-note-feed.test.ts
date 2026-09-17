/**
 * The Activity tab's unplaced notes: the merge, the wording, and the row.
 *
 * The server half is `packages/server/test/unplaced-note-feed.test.ts`; this
 * is the half a reader sees. Both the model functions and the rendered DOM
 * are here because the two answer one question between them — a merge that
 * orders correctly into a row that says nothing is not a surface.
 *
 * All fixtures are synthetic — invented names. The repo is public.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEvent } from '../src/board/board-presence-model.ts';
import { renderActivity } from '../src/board/board-render.ts';
import {
  type UnplacedNote,
  activityFeed,
  unplacedNoteBody,
  unplacedNoteLabel,
} from '../src/board/unplaced-note-feed.ts';

const NOW = 1_700_000_000_000;

const note = (over: Partial<UnplacedNote> = {}): UnplacedNote => ({
  agent: 'Harborlight',
  kind: 'turn',
  text: 'Both arms are green; the second is still building.',
  at: NOW - 45_000,
  ambiguous: true,
  ...over,
});

const EVENTS: ActivityEvent[] = [
  { event: 'task.created', ts: NOW - 60_000, task: { id: 't-1', title: 'A' }, goal: 'chores' },
  {
    event: 'task.transitioned',
    ts: NOW - 30_000,
    taskId: 't-1',
    from: 'todo',
    to: 'done',
    actor: { name: 'Jordan', kind: 'person' },
  },
];

describe('activityFeed', () => {
  it('merges notes and events into one list, newest first', () => {
    const rows = activityFeed(EVENTS, [note()], 'all');
    expect(rows.map((r) => [r.row, r.at])).toEqual([
      ['event', NOW - 30_000],
      ['unplaced', NOW - 45_000],
      ['event', NOW - 60_000],
    ]);
  });

  it('keeps the notes off the Decisions filter', () => {
    // That filter is the rows where somebody exercised placement judgment.
    // An unplaced note is a message no judgment was exercised on.
    const all = activityFeed(EVENTS, [note()], 'all');
    expect(all.some((r) => r.row === 'unplaced')).toBe(true);
    const decisions = activityFeed(EVENTS, [note()], 'decisions');
    expect(decisions.every((r) => r.row === 'event')).toBe(true);
  });

  it('breaks a tie the same way twice, so a repaint cannot reorder the list', () => {
    const tied = note({ at: NOW - 30_000 });
    const first = activityFeed(EVENTS, [tied], 'all').map((r) => r.row);
    const again = activityFeed(EVENTS, [tied], 'all').map((r) => r.row);
    expect(first).toEqual(again);
    expect(first[0]).toBe('event');
  });

  it('renders the audit rows alone when the board has placed everything', () => {
    expect(activityFeed(EVENTS, [], 'all').map((r) => r.row)).toEqual(['event', 'event']);
  });
});

describe('unplacedNoteLabel', () => {
  it('names the agent, what the note was, and that no task took it', () => {
    expect(unplacedNoteLabel(note())).toBe(
      'Harborlight · end-of-turn note · no task took it (several tasks open)',
    );
  });

  it('says which kind of unplaced it was', () => {
    expect(unplacedNoteLabel(note({ ambiguous: false }))).toContain('(no task open)');
  });

  it('never renders a blank for a denial or a status note', () => {
    expect(unplacedNoteLabel(note({ kind: 'denial' }))).toContain('blocked');
    expect(unplacedNoteLabel(note({ kind: 'status' }))).toContain('status note');
  });
});

describe('unplacedNoteBody', () => {
  it('keeps a one-line note whole, with nothing behind an expander', () => {
    expect(unplacedNoteBody('Pushed the branch.')).toEqual({ line: 'Pushed the branch.' });
  });

  it('puts the REST of a multi-line note behind the expander, never the line again', () => {
    // `<details>` keeps its summary on screen while it is open, so handing it
    // the whole note printed the first line twice, one under the other.
    const body = unplacedNoteBody('Shipped the index.\n\nStill waiting on the cache rebuild.');
    expect(body.line).toBe('Shipped the index.');
    expect(body.rest).toBe('Still waiting on the cache rebuild.');
  });

  it('keeps the whole note when the shown line was CLIPPED', () => {
    // The clip dropped characters that exist nowhere else, so the expander
    // has to carry the line it completes.
    const long = `${'x'.repeat(400)}\nand a second line`;
    const body = unplacedNoteBody(long);
    expect(body.line.endsWith('…')).toBe(true);
    expect(body.rest).toBe(long);
  });

  it('clips a very long first line and keeps the whole text reachable', () => {
    const long = `${'x'.repeat(400)} tail`;
    const body = unplacedNoteBody(long);
    expect(body.line.length).toBeLessThanOrEqual(200);
    expect(body.rest).toBe(long);
  });

  it('shows a fenced-code-only note rather than a blank row', () => {
    const body = unplacedNoteBody('```\nbun run verify\n```');
    expect(body.line).toBe('bun run verify');
    expect(body.rest).toBe('```\nbun run verify\n```');
  });
});

describe('the Activity tab renders an unplaced note', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
  });

  const paint = (notes: UnplacedNote[], filter: 'all' | 'decisions' = 'all') =>
    renderActivity(root, EVENTS, filter, () => 'A', vi.fn(), null, notes);

  it('gives it a row of its own, in time order with the audit rows', () => {
    paint([note()]);
    const rows = Array.from(root.querySelectorAll('.board-activity-row'));
    expect(rows).toHaveLength(3);
    expect(rows[1]?.classList.contains('board-activity-unplaced')).toBe(true);
    // The rows on either side are ordinary audit rows: the note landed
    // BETWEEN them rather than at an end.
    expect(rows[0]?.classList.contains('board-activity-unplaced')).toBe(false);
    expect(rows[2]?.classList.contains('board-activity-unplaced')).toBe(false);
  });

  it('says whose note it is, that no task took it, and when', () => {
    paint([note()]);
    const row = root.querySelector('.board-activity-unplaced');
    expect(row?.querySelector('.board-activity-unplaced-label')?.textContent).toBe(
      'Harborlight · end-of-turn note · no task took it (several tasks open)',
    );
    // The age column is the feed's own clock, and it is filled for this row
    // exactly as for an audit row.
    expect(row?.querySelector('.board-activity-when')?.textContent).toMatch(/\S/);
  });

  it('shows the agent’s words', () => {
    paint([note({ text: 'Pushed the branch.' })]);
    expect(root.querySelector('.board-activity-unplaced-text')?.textContent).toBe(
      'Pushed the branch.',
    );
    expect(root.querySelector('.board-activity-unplaced-more')).toBeNull();
  });

  it('keeps the rest of a long note reachable behind an expander', () => {
    // This tab is the note's ONLY surface — there is no task panel to send
    // the reader to — so a clipped line would lose the record.
    const text = 'Shipped the index.\n\nStill waiting on the cache rebuild.';
    paint([note({ text })]);
    const details = root.querySelector('details.board-activity-unplaced-more');
    expect(details).not.toBeNull();
    expect(details?.querySelector('summary')?.textContent).toBe('Shipped the index.');
    const full = details?.querySelector('.board-activity-unplaced-full')?.textContent ?? '';
    expect(full).toBe('Still waiting on the cache rebuild.');
    // Open, the row says each line once — the summary stays on screen, so a
    // full-text body printed the first line directly under itself.
    expect(full).not.toContain('Shipped the index.');
  });

  it('draws nothing extra when the board has placed everything (control)', () => {
    paint([]);
    expect(root.querySelectorAll('.board-activity-row')).toHaveLength(2);
    expect(root.querySelector('.board-activity-unplaced')).toBeNull();
  });

  it('is absent from the Decisions filter', () => {
    paint([note()], 'decisions');
    expect(root.querySelector('.board-activity-unplaced')).toBeNull();
  });

  it('carries no badge, no count and no pulse — calm by default', () => {
    paint([note(), note({ at: NOW - 50_000 })]);
    const row = root.querySelector('.board-activity-unplaced');
    expect(row?.querySelector('[class*="badge"], [class*="pill"], [class*="count"]')).toBeNull();
    // Two notes, two rows — never one row claiming "2 unplaced".
    expect(root.querySelectorAll('.board-activity-unplaced')).toHaveLength(2);
  });
});
