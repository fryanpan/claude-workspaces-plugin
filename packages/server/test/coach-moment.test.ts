/**
 * The coach's loop over a whole day: every event reaches the coach session
 * as it happens, with its words; a moment the session raises reaches the
 * page only when it quotes a goal and no other is open; and a moment stays
 * until he answers it or moves on.
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
import { CoachStream } from '../src/coach/stream.ts';
import {
  DRIFTING_DAY,
  GOALS_DOC,
  LABELLED_POINTS,
  ON_TRACK_DAY,
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

function harness(opts: { goals?: string | null; listening?: boolean } = {}) {
  let clock = at(8);
  const store = new CoachStore(dir, clock);
  store.noteTimeZone(ZONE);
  const frames: CoachFrame[] = [];
  const told: SessionNews[] = [];
  const goals = opts.goals === undefined ? GOALS_DOC : opts.goals;
  const coach = createCoach({
    store,
    stream: new CoachStream(),
    readGoals: () => (goals === null ? null : readGoalsDoc(goals)),
    label,
    boardName: () => 'Harborlight',
    workspaceOf: () => WS,
    tell: (news) => {
      if (opts.listening === false) return false;
      told.push(news);
      return true;
    },
    publish: (f) => frames.push(f),
    now: () => clock,
  });
  const step = (s: Signal) => {
    clock = s.at;
    if ('here' in s) coach.here(s.here);
    else coach.activity(s.row);
  };
  return { store, coach, frames, told, step, setClock: (t: number) => (clock = t) };
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
    });
    expect(sent.find((e) => e.kind === 'comment')).toMatchObject({
      docId: 'd-hover',
      text: 'Try a softer shadow on hover, and a 2px lift.',
    });
    expect(h.store.week(at(18)).eventsToday).toBe(16);
  });

  it('drops a repeat of the same view, and sends a changed passage', () => {
    const h = harness();
    const here = { kind: 'view' as const, workspaceId: WS, docId: 'd-post', visible: true };
    h.coach.here({ ...here, heading: 'Why', text: 'one' });
    h.coach.here({ ...here, heading: 'Why', text: 'one' });
    h.coach.here({ ...here, heading: 'Why', text: 'two' });
    expect(events(h.told).map((e) => e.text)).toEqual(['one', 'two']);
  });

  it('with no session listening, nothing is counted', () => {
    const h = harness({ listening: false });
    for (const s of ON_TRACK_DAY) h.step(s);
    expect(h.store.week(at(18)).eventsToday).toBe(0);
  });
});

describe('a moment', () => {
  it('the drifting day, with a session that speaks at each labelled point, shows three cards, each closed when he moves on', () => {
    const h = harness();
    const speakAfter = new Map(
      LABELLED_POINTS.filter((p) => p.expect === 'speak').map((p) => [p.after, p.goalIndex ?? 0]),
    );
    DRIFTING_DAY.forEach((s, i) => {
      h.step(s);
      const g = speakAfter.get(i);
      if (g !== undefined) expect(h.coach.raise(MOMENTS[g] ?? null)).toMatchObject({ ok: true });
    });
    const shown = h.frames.filter((f) => f.type === 'moment');
    expect(shown.map((f) => f.type === 'moment' && f.moment.goal)).toEqual([
      'Do the hard, important work before the easy polish.',
      'Answer people who are waiting on me the same day.',
      'Say why a thing matters before deciding how to build it.',
    ]);
    expect(h.store.moments().map((m) => [m.docId, m.state])).toEqual([
      ['d-hover', 'moved-on'],
      ['d-tokens', 'moved-on'],
      ['d-booking', 'moved-on'],
    ]);
    const answers = h.told.filter((n) => n.event === 'coach.answer');
    expect(answers.map((n) => n.event === 'coach.answer' && n.answer)).toEqual([
      'moved-on',
      'moved-on',
      'moved-on',
    ]);
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

  it('raised before any page said where he was, it closes on his first move', () => {
    const h = harness();
    const raised = h.coach.raise(MOMENTS[0] ?? null);
    h.coach.here({ kind: 'view', workspaceId: WS, docId: 'd-post', visible: true });
    expect(h.store.moments().find((m) => raised.ok && m.id === raised.id)?.state).toBe('moved-on');
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
    expect(h.coach.answer(id, 'not-now')).toBe(true);
    expect(h.coach.answer(id, 'thanks')).toBe(false);
    expect(h.frames.at(-1)).toEqual({ type: 'clear', id });
    h.coach.setReadiness('less');
    expect(h.told.slice(-2)).toEqual([
      {
        event: 'coach.answer',
        momentId: id,
        answer: 'not-now',
        goal: 'Do the hard, important work before the easy polish.',
        line: MOMENTS[0]?.line ?? '',
      },
      { event: 'coach.preference', readiness: 'less' },
    ]);
    expect(h.store.readiness).toBe('less');
  });
});
