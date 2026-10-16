/**
 * Boards the coach never hears from: local-only, locked, shared, or turned
 * off by him. An event there is not sent at all, not even the board's name,
 * and a check that throws counts as off.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentPrivacyStore } from '../src/attachment-privacy.ts';
import {
  type BoardPrivacy,
  boardOffReason,
  boardPrivacyFrom,
  placeIsOff,
} from '../src/coach/exclusion.ts';
import { readGoalsDoc } from '../src/coach/goals-doc.ts';
import { createCoach } from '../src/coach/moment.ts';
import type { SessionNews } from '../src/coach/session-feed.ts';
import { CoachStore } from '../src/coach/store.ts';
import { CoachStream } from '../src/coach/stream.ts';
import { GOALS_DOC, WS, ZONE, at } from './coach-fixtures.ts';

const OPEN: BoardPrivacy = {
  localOnlyBoard: () => false,
  localOnlyDoc: () => false,
  locked: () => false,
  boardsOfDoc: () => [],
};
const NONE = new Set<string>();

describe('boardOffReason', () => {
  it('names each reason, and null for a board only he can reach', () => {
    expect(boardOffReason('w-a', OPEN, NONE)).toBeNull();
    expect(boardOffReason('w-a', OPEN, new Set(['w-a']))).toBe('turned-off');
    expect(boardOffReason('w-a', { ...OPEN, localOnlyBoard: () => true }, NONE)).toBe('local-only');
    expect(boardOffReason('w-a', { ...OPEN, locked: () => true }, NONE)).toBe('locked');
    const broken = {
      ...OPEN,
      locked: () => {
        throw new Error('not built yet');
      },
    };
    expect(boardOffReason('w-a', broken, NONE)).toBe('unknown');
  });
});

describe('placeIsOff', () => {
  it('is off for a local-only doc, or a doc that is also on an off board', () => {
    expect(placeIsOff({ workspaceId: 'w-a', docId: 'd-1' }, OPEN, NONE)).toBe(false);
    const localDoc = { ...OPEN, localOnlyDoc: (id: string) => id === 'd-1' };
    expect(placeIsOff({ workspaceId: 'w-a', docId: 'd-1' }, localDoc, NONE)).toBe(true);
    const alsoLocked = {
      ...OPEN,
      boardsOfDoc: () => ['w-a', 'w-b'],
      locked: (id: string) => id === 'w-b',
    };
    expect(placeIsOff({ workspaceId: 'w-a', docId: 'd-1' }, alsoLocked, NONE)).toBe(true);
    expect(placeIsOff({ workspaceId: 'w-a' }, alsoLocked, NONE)).toBe(false);
    expect(placeIsOff({ workspaceId: 'w-a' }, OPEN, new Set(['w-a']))).toBe(true);
  });

  it('counts a check that throws as off', () => {
    const throws = () => {
      throw new Error('store not ready');
    };
    expect(
      placeIsOff({ workspaceId: 'w-a', docId: 'd-1' }, { ...OPEN, localOnlyDoc: throws }, NONE),
    ).toBe(true);
    expect(
      placeIsOff({ workspaceId: 'w-a', docId: 'd-1' }, { ...OPEN, boardsOfDoc: throws }, NONE),
    ).toBe(true);
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

/** A coach over the real privacy store, with one medical-style board marked local-only. */
function coachWithRecords() {
  const attachmentPrivacy = new AttachmentPrivacyStore(dir);
  attachmentPrivacy.set(RECORDS, 'local-only');
  const docBoard: Record<string, string> = { [RECORDS_DOC]: RECORDS, 'd-post': WS };
  const privacy = boardPrivacyFrom({
    isLocalOnlySet: (id) => attachmentPrivacy.isLocalOnly(id),
    setOfDoc: () => undefined,
    repoKeyOf: () => undefined,
    projectIsLocalOnly: () => false,
    docIdsOf: (ws) => Object.keys(docBoard).filter((d) => docBoard[d] === ws),
    isBoardLocked: () => false,
    boardsOfDoc: (d) => (docBoard[d] ? [docBoard[d]] : []),
  });
  let clock = at(9);
  const store = new CoachStore(dir, clock);
  store.noteTimeZone(ZONE);
  const told: SessionNews[] = [];
  const coach = createCoach({
    store,
    stream: new CoachStream(),
    readGoals: () => readGoalsDoc(GOALS_DOC),
    label: (d) => ({ title: d === RECORDS_DOC ? RECORDS_TITLE : 'Harborlight launch post draft' }),
    boardName: (ws) => (ws === RECORDS ? RECORDS_NAME : 'Harborlight'),
    workspaceOf: (d) => docBoard[d],
    isOff: (place) => placeIsOff(place, privacy, store.offBoards),
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

describe('a local-only board, through the whole coach', () => {
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
