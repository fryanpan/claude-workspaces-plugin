/**
 * The coach's loop: everything he does goes to the coach session, and a
 * moment comes back when the session sees one.
 *
 * Signals from his pages and his activity rows become events
 * (`coach/stream.ts`), and each event goes to the session as it happens
 * (`coach/session-feed.ts`). His answers to a moment and his how-readily
 * setting go too, so the session learns from them; nothing here holds a
 * timer, a cap or a spacing rule.
 *
 * A moment the session raises (`raise`) reaches his pages only when there is
 * a goal to act on, no other moment is open, and its quote checks out
 * (`coach/judge.ts`). It stays on the page until he answers it or moves to
 * another doc or board, which closes it as `moved-on`.
 */
import type { Event } from '../activity.ts';
import { type GoalsDocReading, actionableGoals, goalTitle } from './goals-doc.ts';
import { checkMoment } from './judge.ts';
import type { SessionNews } from './session-feed.ts';
import type { CoachStore } from './store.ts';
import type { CoachEvent, CoachStream, HereSignal, StreamStep } from './stream.ts';
import type { CoachMoment, CoachReadiness, MomentAnswer } from './types.ts';

export const DEFAULT_COACH_NAME = 'Your coach';

export interface DocLabel {
  title?: string;
  board?: string;
}

/** What a page is told. */
export type CoachFrame =
  | { type: 'moment'; moment: { id: string; at: number; name: string; line: string; goal: string } }
  | { type: 'clear'; id: string };

export type RaiseResult =
  | { ok: true; id: string }
  | { ok: false; error: 'no-goals' | 'moment-open' | 'bad-moment'; message: string };

export interface CoachDeps {
  store: CoachStore;
  stream: CoachStream;
  /** The goals doc as it reads now, or null when there is none. */
  readGoals: () => GoalsDocReading | null;
  label: (docId: string) => DocLabel;
  boardName: (workspaceId: string) => string | undefined;
  workspaceOf: (docId: string) => string | undefined;
  /** To the coach session; true when it took the frame. */
  tell: (news: SessionNews, at: number) => boolean;
  publish: (frame: CoachFrame) => void;
  now?: () => number;
}

export interface Coach {
  here(signal: Omit<HereSignal, 'at'>): void;
  activity(row: Event): void;
  /** The session raises a moment. */
  raise(body: Record<string, unknown> | null): RaiseResult;
  answer(id: string, answer: MomentAnswer): boolean;
  setReadiness(readiness: CoachReadiness): void;
  /** The open moment as a page shows it, if any. */
  openFrame(): CoachFrame | null;
}

export function createCoach(deps: CoachDeps): Coach {
  const now = deps.now ?? Date.now;
  const name = (reading: GoalsDocReading | null) => reading?.name ?? DEFAULT_COACH_NAME;

  const frameOf = (m: CoachMoment, reading: GoalsDocReading | null): CoachFrame => ({
    type: 'moment',
    moment: { id: m.id, at: m.at, name: name(reading), line: m.line, goal: m.goal },
  });

  const close = (m: CoachMoment, answer: MomentAnswer | 'moved-on', t: number): boolean => {
    if (!deps.store.answer(m.id, answer, t)) return false;
    deps.publish({ type: 'clear', id: m.id });
    deps.tell({ event: 'coach.answer', momentId: m.id, answer, goal: m.goal, line: m.line }, t);
    return true;
  };

  const forward = (e: CoachEvent) => {
    const label = e.docId ? deps.label(e.docId) : {};
    const board = deps.boardName(e.workspaceId);
    const sent = deps.tell(
      {
        event: 'coach.event',
        kind: e.kind,
        boardId: e.workspaceId,
        ...(board ? { board } : {}),
        ...(e.docId ? { docId: e.docId } : {}),
        ...(label.title ? { doc: label.title } : {}),
        ...(e.heading ? { heading: e.heading } : {}),
        ...(e.text ? { text: e.text } : {}),
      },
      e.at,
    );
    if (sent) deps.store.countEvent(e.at);
  };

  /** He moved: a moment raised somewhere else closes, then the events go.
   *  One raised before any page said where he was closes on his first move. */
  const take = (step: StreamStep, t: number) => {
    const open = deps.store.openMoment();
    const place = deps.stream.current;
    if (step.moved && open && place) {
      const there = open.docId
        ? open.docId === place.docId
        : !place.docId && open.workspaceId === place.workspaceId;
      if (!there) close(open, 'moved-on', t);
    }
    for (const e of step.events) forward(e);
  };

  return {
    here(signal) {
      const t = now();
      take(deps.stream.here({ ...signal, at: t }), t);
    },
    activity(row) {
      if (!row.isOwner) return;
      const t = now();
      const goalsDoc = deps.store.goalsDoc;
      if (goalsDoc && row.type === 'edit_session' && row.doc?.docId === goalsDoc.docId) {
        deps.store.noteGoalsChanged(t);
      }
      take(deps.stream.activity(row, t, deps.workspaceOf), t);
    },
    raise(body) {
      const t = now();
      const reading = deps.readGoals();
      const goals = reading ? actionableGoals(reading) : [];
      if (goals.length === 0) {
        return {
          ok: false,
          error: 'no-goals',
          message: 'He has no goal with "Act differently when" filled in.',
        };
      }
      if (deps.store.openMoment()) {
        return { ok: false, error: 'moment-open', message: 'A moment is already on his page.' };
      }
      const checked = checkMoment(body, goals);
      if (typeof checked === 'string') return { ok: false, error: 'bad-moment', message: checked };
      const goal = goals[checked.goalIndex];
      const place = deps.stream.current;
      const m = deps.store.addMoment({
        at: t,
        goalIndex: checked.goalIndex,
        goal: goal ? goalTitle(goal) : '',
        matched: checked.matched,
        observed: checked.observed,
        line: checked.line,
        ...(place ? { workspaceId: place.workspaceId } : {}),
        ...(place?.docId ? { docId: place.docId } : {}),
      });
      deps.publish(frameOf(m, reading));
      return { ok: true, id: m.id };
    },
    answer(id, answer) {
      const m = deps.store.openMoment();
      return m?.id === id ? close(m, answer, now()) : false;
    },
    setReadiness(readiness) {
      deps.store.setReadiness(readiness);
      deps.tell({ event: 'coach.preference', readiness }, now());
    },
    openFrame() {
      const m = deps.store.openMoment();
      return m ? frameOf(m, deps.readGoals()) : null;
    },
  };
}
