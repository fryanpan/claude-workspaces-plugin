/**
 * The coach: the owner's learning goals, what it sees him doing, and the moments
 * it raises when what he is doing matches a goal's "act differently when".
 *
 * The design is the "Version 1 design" section of the coach doc on the
 * Workspaces board, in three workflows: A, set the goals (one doc, filled in
 * by the voice interview); B, watch (owner activity rows plus a where-I-am
 * signal from board and doc pages); C, speak up (a card on the page he is
 * on). Everything here is the owner's alone: nothing is on a share or a member
 * allowlist, and the one agent stream it reaches is the coach session's.
 *
 * Nothing is ever deleted. A moment leaves the page by being answered or
 * left behind, never by being removed.
 */

/** How readily the coach speaks up, as he set it. It is told to the coach
 *  session, which weighs it; no timer reads it. */
export type CoachReadiness = 'less' | 'normal' | 'more';
export const COACH_READINESS: readonly CoachReadiness[] = ['less', 'normal', 'more'];

/** Where one of the coach's docs is, once it exists. */
export interface CoachDocRef {
  workspaceId: string;
  docId: string;
  createdAt: number;
}

/**
 * `open` shows on the page. `up` and `down` are his two answers, a thumbs up
 * or down; a down may carry a few words of why. `thanks`, `not-now` and
 * `not-this` are the three answers the card offered before, and `moved-on`
 * one he left, from before a moment followed him from page to page: nothing
 * gives either now, and old records keep them.
 */
export type MomentState = 'open' | MomentAnswer | 'thanks' | 'not-now' | 'not-this' | 'moved-on';
export type MomentAnswer = 'up' | 'down';
export const MOMENT_ANSWERS: readonly MomentAnswer[] = ['up', 'down'];
/** What he may write with a thumbs down. */
export const ANSWER_TEXT_CHARS = 1_000;

export interface CoachMoment {
  /** `cm-` + 12 characters. */
  id: string;
  at: number;
  /** The local day it was raised on, `YYYY-MM-DD`. */
  day: string;
  /** 0-based, into the goals as the doc held them then. */
  goalIndex: number;
  /** The goal's title then, so a later edit cannot change what it was about. */
  goal: string;
  /** The words of that goal's "act differently when" the model matched. */
  matched: string;
  /** Where he was when it was raised. The card follows him from there. */
  workspaceId?: string;
  docId?: string;
  /** What the coach saw, in its words. */
  observed: string;
  /** The one line the card shows, ending in a question. */
  line: string;
  state: MomentState;
  answeredAt?: number;
  /** What he wrote with a thumbs down. */
  answerText?: string;
}

export interface CoachState {
  /** His time zone, from the browser he last used. */
  timeZone: string;
  /** The learning-goals doc. The coach's name and the goals are read from
   *  it each time, never copied here. */
  goalsDoc?: CoachDocRef;
  /** The coach session's memory doc, on the same board. */
  memoryDoc?: CoachDocRef;
  readiness: CoachReadiness;
  /** The last time he changed the goals doc (his own edit). */
  goalsChangedAt?: number;
  /** The last time he said the goals need no update. */
  reviewDeclinedAt?: number;
  moments: CoachMoment[];
  /** Events sent to the coach session, per local day (`YYYY-MM-DD`), the
   *  last `KEEP_EVENT_DAYS`: each is one session turn, so this is the cost
   *  the server can see. */
  eventsByDay: Record<string, number>;
  /** Boards he turned the coach off for ("Coach off for this board"). */
  offBoards: string[];
  /** The last local day (`YYYY-MM-DD`) the morning wake-up came, whether
   *  the session took it or not (`coach/morning.ts`): never twice a day. */
  morningDay?: string;
}

export const KEEP_EVENT_DAYS = 14;
/** Events a day the coach session is sent, then nothing until tomorrow: the
 *  spend limit, about $20 at the estimated $0.05 a turn. */
export const DAILY_EVENT_LIMIT = 400;
/** The local hour the coach session gets its one morning wake-up
 *  (`coach/morning.ts`), in his zone. */
export const MORNING_HOUR = 8;
/** The weekly offer to review the goals. */
export const REVIEW_AFTER_MS = 7 * 24 * 60 * 60_000;
