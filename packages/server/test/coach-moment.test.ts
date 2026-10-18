/**
 * The coach's loop over a whole day: every event reaches the coach session
 * as it happens, with its words; a moment the session raises reaches the
 * page only when it quotes a goal and no other is open; and a moment follows
 * him from page to page until he answers it.
 *
 * The session here is a stand-in that raises a moment after the drifting
 * day's labelled "speak" points, which proves the plumbing and nothing
 * about judgement. `scripts/coach-eval.ts` plays the same day to a real
 * coach session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGoalsDoc } from '../src/coach/goals-doc.ts';
import { type CoachFrame, createCoach } from '../src/coach/moment.ts';
import type { SessionNews } from '../src/coach/session-feed.ts';
import { CoachStore } from '../src/coach/store.ts';
import { CoachStream, PAGE_PLACES } from '../src/coach/stream.ts';
import {
  DRIFTING_DAY,
  GOALS_DOC,
  LABELLED_POINTS,
  SPOKEN_GOALS_DOC,
  type Signal,
  WS,
  ZONE,
  at,
  label,
} from './coach-fixtures.ts';

/** What the stand-in session sends after a "speak" point, per goal. */
const MOMENTS = [
  {
    goal: 1,
    matched: 'more than twenty minutes on styling or polish',
    observed: 'Half an hour on the button hover mock',
    line: 'Hi, I’m noticing half an hour on hover states, with the launch post unfinished. Back to the post?',
  },
  {
    goal: 2,
    matched: 'move on without replying',
    observed: 'Read the Riverbend partner’s message and opened the colour tokens',
    line: 'Hi, I’m noticing you left the Riverbend partner’s question unanswered. Two lines now?',
  },
  {
    goal: 3,
    matched: 'I start on a solution before',
    observed: 'Designing the importer in a spec that never says why',
    line: 'Hi, I’m noticing the importer design came before any why. Who has the problem it solves?',
  },
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-moment-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function harness(
  opts: {
    goals?: string | null;
    listening?: boolean;
    isOff?: (place: { workspaceId: string; docId?: string }) => boolean;
  } = {},
) {
  let clock = at(8);
  const store = new CoachStore(dir, clock);
  store.noteTimeZone(ZONE);
  const frames: CoachFrame[] = [];
  const reshown: CoachFrame[] = [];
  const told: SessionNews[] = [];
  const goals = opts.goals === undefined ? GOALS_DOC : opts.goals;
  const coach = createCoach({
    store,
    stream: new CoachStream(),
    readGoals: () => (goals === null ? null : readGoalsDoc(goals)),
    label,
    boardName: () => 'Harborlight',
    workspaceOf: () => WS,
    isOff: opts.isOff ?? (() => false),
    tell: (news) => {
      if (opts.listening === false) return false;
      told.push(news);
      return true;
    },
    publish: (f) => frames.push(f),
    reshow: (f) => {
      if (f) reshown.push(f);
    },
    now: () => clock,
  });
  const step = (s: Signal) => {
    clock = s.at;
    if ('here' in s) coach.here(s.here);
    else coach.activity(s.row);
  };
  return { store, coach, frames, reshown, told, step, setClock: (t: number) => (clock = t) };
}

const events = (told: SessionNews[]) => told.filter((n) => n.event === 'coach.event');

describe('every event reaches the session', () => {
  it('as it happens, with its words and where he was, and nothing an agent did', () => {
    const h = harness();
    for (const s of DRIFTING_DAY) h.step(s);
    const sent = events(h.told);
    // 17 signals: the agent's edit row is not his, so 16 events.
    expect(sent).toHaveLength(16);
    expect(sent[1]).toEqual({
      event: 'coach.event',
      kind: 'wrote',
      boardId: WS,
      board: 'Harborlight',
      docId: 'd-post',
      doc: 'Harborlight launch post draft',
      heading: 'Why we built it',
      text: 'The paper books get wet, and a berth is sold twice.',
      source: 'other',
    });
    expect(sent.find((e) => e.kind === 'comment')).toMatchObject({
      docId: 'd-hover',
      text: 'Try a softer shadow on hover, and a 2px lift.',
    });
  });

  it('drops a repeat of the same view, and sends a changed passage', () => {
    const h = harness();
    const here = { kind: 'view' as const, workspaceId: WS, docId: 'd-post', visible: true };
    h.coach.here({ ...here, heading: 'Why', text: 'one' });
    h.coach.here({ ...here, heading: 'Why', text: 'one' });
    h.coach.here({ ...here, heading: 'Why', text: 'two' });
    expect(events(h.told).map((e) => e.text)).toEqual(['one', 'two']);
  });
});

describe('a page with no board', () => {
  it('reaches the session as the front page or the review walk, by name, with the device it came from', () => {
    const h = harness();
    h.setClock(at(21, 10));
    h.coach.here({
      kind: 'view',
      workspaceId: PAGE_PLACES.review.id,
      visible: true,
      source: 'phone',
    });
    h.setClock(at(21, 30));
    h.coach.here({
      kind: 'view',
      workspaceId: PAGE_PLACES.home.id,
      visible: true,
      source: 'phone',
    });
    expect(events(h.told)).toEqual([
      expect.objectContaining({
        kind: 'view',
        boardId: 'page:review',
        board: 'Review walk',
        source: 'phone',
      }),
      expect.objectContaining({ kind: 'view', boardId: 'page:home', board: 'Home' }),
    ]);
  });
});

describe('a moment', () => {
  it('the drifting day, with a session that speaks at each labelled point, shows three cards, each open until he answers it', () => {
    const h = harness();
    const speakAfter = new Map(
      LABELLED_POINTS.filter((p) => p.expect === 'speak').map((p) => [p.after, p.goalIndex ?? 0]),
    );
    DRIFTING_DAY.forEach((s, i) => {
      h.step(s);
      const g = speakAfter.get(i);
      if (g === undefined) return;
      // The last card is still open, however far he has moved since: he
      // answers it now, so the next can be raised.
      const open = h.coach.openFrame();
      if (open?.type === 'moment') expect(h.coach.answer(open.moment.id, 'down')).toBe(true);
      expect(h.coach.raise(MOMENTS[g] ?? null)).toMatchObject({ ok: true });
    });
    const shown = h.frames.filter((f) => f.type === 'moment');
    expect(shown.map((f) => f.type === 'moment' && f.moment.goal)).toEqual([
      'Do the hard, important work before the easy polish.',
      'Answer people who are waiting on me the same day.',
      'Say why a thing matters before deciding how to build it.',
    ]);
    expect(h.store.moments().map((m) => [m.docId, m.state])).toEqual([
      ['d-hover', 'down'],
      ['d-tokens', 'down'],
      ['d-booking', 'open'],
    ]);
    const answers = h.told.filter((n) => n.event === 'coach.answer');
    expect(answers.map((n) => n.event === 'coach.answer' && n.answer)).toEqual(['down', 'down']);
  });

  it('is refused with no goals, while another is open, and when its quote is not the goal’s words', () => {
    expect(harness({ goals: null }).coach.raise(MOMENTS[0] ?? null)).toMatchObject({
      ok: false,
      error: 'no-goals',
    });
    const h = harness();
    expect(h.coach.raise({ ...MOMENTS[0], matched: 'polish is fun' })).toMatchObject({
      ok: false,
      error: 'bad-moment',
    });
    expect(h.coach.raise(MOMENTS[0] ?? null)).toMatchObject({ ok: true });
    expect(h.coach.raise(MOMENTS[1] ?? null)).toMatchObject({ ok: false, error: 'moment-open' });
    expect(h.frames.filter((f) => f.type === 'moment')).toHaveLength(1);
  });

  it('reaches the page from a doc filled in by voice, with no trigger part', () => {
    const h = harness({ goals: SPOKEN_GOALS_DOC });
    const raised = h.coach.raise({
      goal: 1,
      matched: 'more than about an hour on a mock',
      observed: 'An hour and ten minutes on the hover mock',
      line: 'Hi, I’m noticing over an hour on the hover mock. Is the Harborlight post done?',
    });
    expect(raised).toMatchObject({ ok: true });
    expect(h.frames[0]).toMatchObject({
      type: 'moment',
      moment: {
        name: 'Riverbend',
        goal: 'If I spend more than about an hour on a mock, ask me whether the Harborlight post is done.',
      },
    });
  });

  it('follows him to another board, a doc and a board the coach is off for, and closes only when he answers', () => {
    const h = harness({ isOff: (p) => p.workspaceId === 'w-records' });
    h.coach.here({ kind: 'view', workspaceId: WS, docId: 'd-hover', visible: true });
    const raised = h.coach.raise(MOMENTS[0] ?? null);
    const id = raised.ok ? raised.id : '';
    const stillOpen = () => {
      expect(h.coach.openFrame()).toMatchObject({ type: 'moment', moment: { id } });
      expect(h.frames.filter((f) => f.type === 'clear')).toEqual([]);
      expect(h.told.some((n) => n.event === 'coach.answer')).toBe(false);
    };
    h.setClock(at(9));
    h.coach.here({ kind: 'view', workspaceId: 'w-riverbend', visible: true });
    stillOpen();
    h.coach.here({ kind: 'view', workspaceId: 'w-riverbend', docId: 'd-post', visible: true });
    stillOpen();
    // Off for the coach: the page there is told again, so its card can say
    // the coach is not listening, and the moment stays open.
    h.coach.here({ kind: 'view', workspaceId: 'w-records', docId: 'd-letters', visible: true });
    stillOpen();
    expect(h.reshown).toEqual([
      expect.objectContaining({ type: 'moment', moment: expect.objectContaining({ id }) }),
    ]);
    h.coach.setBoardOff(WS, true);
    stillOpen();
    h.setClock(at(22));
    h.coach.here({ kind: 'view', workspaceId: 'w-riverbend', visible: true });
    stillOpen();
    expect(h.coach.answer(id, 'down')).toBe(true);
    expect(h.frames.at(-1)).toEqual({ type: 'clear', id });
    expect(h.store.moments().find((m) => m.id === id)?.state).toBe('down');
    expect(h.coach.openFrame()).toBeNull();
  });

  it('stays however long he leaves it on the same page', () => {
    const h = harness();
    h.coach.here({ kind: 'view', workspaceId: WS, docId: 'd-hover', visible: true });
    const raised = h.coach.raise(MOMENTS[0] ?? null);
    h.setClock(at(23));
    h.coach.here({ kind: 'view', workspaceId: WS, docId: 'd-hover', visible: false });
    h.coach.here({ kind: 'view', workspaceId: WS, docId: 'd-hover', visible: true, text: 'x' });
    expect(h.coach.openFrame()).toMatchObject({
      type: 'moment',
      moment: { id: raised.ok ? raised.id : '' },
    });
  });

  it('his answer clears every page and is told to the session; so is his readiness', () => {
    const h = harness();
    const raised = h.coach.raise(MOMENTS[0] ?? null);
    const id = raised.ok ? raised.id : '';
    expect(h.coach.answer(id, 'down')).toBe(true);
    expect(h.coach.answer(id, 'up')).toBe(false);
    expect(h.frames.at(-1)).toEqual({ type: 'clear', id });
    h.coach.setReadiness('less');
    expect(h.told.slice(-2)).toEqual([
      {
        event: 'coach.answer',
        momentId: id,
        answer: 'down',
        goal: 'Do the hard, important work before the easy polish.',
        line: MOMENTS[0]?.line ?? '',
      },
      { event: 'coach.preference', readiness: 'less' },
    ]);
    expect(h.store.readiness).toBe('less');
  });
});
