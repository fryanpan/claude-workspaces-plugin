/**
 * The one kind of board the coach never hears from: one he turned off with
 * "Coach off for this board". An event there is not sent at all, not even the
 * board's name. Local-only, locked and shared boards are not off (the owner,
 * 2026-10-28: "All boards.").
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DocBoards, placeIsOff } from '../src/coach/exclusion.ts';
import { readGoalsDoc } from '../src/coach/goals-doc.ts';
import { createCoach } from '../src/coach/moment.ts';
import type { SessionNews } from '../src/coach/session-feed.ts';
import { CoachStore } from '../src/coach/store.ts';
import { CoachStream } from '../src/coach/stream.ts';
import { GOALS_DOC, WS, ZONE, at } from './coach-fixtures.ts';

const NO_BOARDS: DocBoards = { boardsOfDoc: () => [] };
const NONE = new Set<string>();
const throws = (): never => {
  throw new Error('store not ready');
};

describe('placeIsOff', () => {
  it('is off for a board he turned off, and for nothing else', () => {
    expect(placeIsOff({ workspaceId: 'w-a', docId: 'd-1' }, NO_BOARDS, NONE)).toBe(false);
    expect(placeIsOff({ workspaceId: 'w-a' }, NO_BOARDS, new Set(['w-a']))).toBe(true);
    expect(placeIsOff({ workspaceId: 'w-a' }, NO_BOARDS, new Set(['w-b']))).toBe(false);
  });

  it('is off for a doc that is also on a board he turned off', () => {
    const both: DocBoards = { boardsOfDoc: (d) => (d === 'd-1' ? ['w-a', 'w-b'] : []) };
    const offB = new Set(['w-b']);
    expect(placeIsOff({ workspaceId: 'w-a', docId: 'd-1' }, both, offB)).toBe(true);
    // The control: the same board, with no doc, or another doc.
    expect(placeIsOff({ workspaceId: 'w-a' }, both, offB)).toBe(false);
    expect(placeIsOff({ workspaceId: 'w-a', docId: 'd-2' }, both, offB)).toBe(false);
  });

  it('counts a doc whose boards cannot be read as off, once any board is turned off', () => {
    const broken: DocBoards = { boardsOfDoc: throws };
    expect(placeIsOff({ workspaceId: 'w-a', docId: 'd-1' }, broken, new Set(['w-b']))).toBe(true);
    // With no board turned off, no board holding it can be off.
    expect(placeIsOff({ workspaceId: 'w-a', docId: 'd-1' }, broken, NONE)).toBe(false);
  });
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-exclusion-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RECORDS = 'w-records';
const RECORDS_NAME = 'Saltmarsh family records';
const RECORDS_DOC = 'd-records';
const RECORDS_TITLE = 'Saltmarsh clinic letters';

/** A coach with one medical-style board he turned off. */
function coachWithRecords() {
  const docBoard: Record<string, string> = { [RECORDS_DOC]: RECORDS, 'd-post': WS };
  const docBoards: DocBoards = { boardsOfDoc: (d) => (docBoard[d] ? [docBoard[d]] : []) };
  let clock = at(9);
  const store = new CoachStore(dir, clock);
  store.noteTimeZone(ZONE);
  store.setBoardOff(RECORDS, true);
  const told: SessionNews[] = [];
  const coach = createCoach({
    store,
    stream: new CoachStream(),
    readGoals: () => readGoalsDoc(GOALS_DOC),
    label: (d) => ({ title: d === RECORDS_DOC ? RECORDS_TITLE : 'Harborlight launch post draft' }),
    boardName: (ws) => (ws === RECORDS ? RECORDS_NAME : 'Harborlight'),
    workspaceOf: (d) => docBoard[d],
    isOff: (place) => placeIsOff(place, docBoards, store.offBoards),
    tell: (news) => {
      told.push(news);
      return true;
    },
    publish: () => {},
    reshow: () => {},
    now: () => clock,
  });
  return { coach, store, told, tick: () => (clock += 60_000) };
}

const POST = { kind: 'view' as const, workspaceId: WS, docId: 'd-post', visible: true };
const RECORDS_VIEW = {
  kind: 'view' as const,
  workspaceId: RECORDS,
  docId: RECORDS_DOC,
  visible: true,
  heading: 'Results',
  text: 'Saltmarsh, follow-up in six weeks.',
};
const MOMENT = {
  goal: 1,
  matched: 'more than twenty minutes on styling or polish',
  observed: 'Half an hour on the button hover mock',
  line: 'Hi, I’m noticing half an hour on hover states. Back to the post?',
};

describe('a board he turned off, through the whole coach', () => {
  it('sends nothing from it, not its name, id, title or words, and leaves the open moment open', () => {
    const h = coachWithRecords();
    h.coach.here(POST);
    const raised = h.coach.raise(MOMENT);
    expect(raised.ok).toBe(true);
    const before = h.told.length;
    h.tick();
    h.coach.here(RECORDS_VIEW);
    h.tick();
    h.coach.here({ ...RECORDS_VIEW, kind: 'wrote', text: 'Saltmarsh, results normal.' });
    h.coach.activity({
      eventId: 'ev-r',
      ts: new Date(at(9, 3)).toISOString(),
      type: 'comment',
      actor: 'person',
      isOwner: true,
      doc: { docId: RECORDS_DOC },
      payload: { text: 'Ask about the dosage' },
    } as never);
    const after = h.told.slice(before);
    // The post's own "left" goes: he moved, and the coach is not told
    // where. The moment is not answered: it waits for his next page.
    expect(after).toEqual([
      expect.objectContaining({ event: 'coach.event', kind: 'left', boardId: WS, docId: 'd-post' }),
    ]);
    const wire = JSON.stringify(h.told);
    for (const secret of [
      RECORDS,
      RECORDS_NAME,
      RECORDS_DOC,
      RECORDS_TITLE,
      'Saltmarsh',
      'dosage',
    ]) {
      expect(wire).not.toContain(secret);
    }
    expect(h.store.moments().find((m) => raised.ok && m.id === raised.id)?.state).toBe('open');
  });

  it('a hidden tab on it tells the coach nothing, not even that he left', () => {
    const h = coachWithRecords();
    h.coach.here(POST);
    const before = h.told.length;
    h.coach.here({ ...RECORDS_VIEW, visible: false });
    expect(h.told.slice(before)).toEqual([]);
  });
});

describe('Coach off for this board', () => {
  it('turning it off where he is stops the events and keeps the moment open; on again resumes them', () => {
    const h = coachWithRecords();
    h.coach.here(POST);
    const raised = h.coach.raise(MOMENT);
    h.coach.setBoardOff(WS, true);
    expect(h.store.offBoards.has(WS)).toBe(true);
    expect(h.store.moments().find((m) => raised.ok && m.id === raised.id)?.state).toBe('open');
    const before = h.told.length;
    h.tick();
    h.coach.here({ ...POST, heading: 'Why', text: 'The paper books get wet.' });
    expect(h.told.slice(before)).toEqual([]);
    h.coach.setBoardOff(WS, false);
    h.tick();
    h.coach.here({ ...POST, heading: 'Why', text: 'The paper books get wet.' });
    expect(h.told.slice(before).some((n) => n.event === 'coach.event')).toBe(true);
  });
});
