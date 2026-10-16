/**
 * The coach session's feed: every event, as it happens, to the Claude Code
 * session that is the coach (the owner, 2026-10-03: "routing all events to a
 * long running Claude Code session ... that can hold an ongoing
 * conversation with context").
 *
 * The session is the lead of the Coach board, launched once and kept
 * running all week by the fleet's respawn. Each frame is one addressed
 * frame to it on that board: what he did in the last window
 * (`coach.digest`), how he answered a moment (`coach.answer`), and how
 * readily he wants it to speak up (`coach.preference`). The session decides
 * whether to speak, and raises a moment through `POST /coach/moments`;
 * nothing here waits on it.
 *
 * Every frame is a session turn, and one turn per event cost 86 turns and
 * 9.7M tokens in five hours with nothing said. So what he does is held: the
 * first event opens a window, and when it closes 15 minutes later the
 * window goes as one digest (`coach/digest.ts`). A quiet stretch opens no
 * window and sends nothing. His answers and his setting go at once. Each
 * digest also carries this week's plan goals in plan order
 * (`coach/week-plan.ts`), so the session ranks by the plan, not by titles,
 * and his Claude Code time per attached session (`coach/session-minutes.ts`).
 * A prompt he typed opens a window as a board event does, so terminal work
 * with no board page open still reaches the coach. A turn end never opens
 * one: it joins a window already open, so agents working alone overnight
 * wake nobody.
 *
 * Once a local day the session also gets a morning wake-up
 * (`coach.morning`, `coach/morning.ts`), so it can check what has not moved.
 *
 * A day has a budget of turns (`DAILY_EVENT_LIMIT`): a digest and the
 * morning wake-up each spend one. Past it nothing is sent until his next
 * local day, and the front page says the coach is paused.
 *
 * With no lead, or a lead holding no stream, nothing is sent: an addressed
 * frame is replayed to a stream that comes back, so a session that is gone
 * would otherwise read a backlog of stale events when it returns.
 */
import { HeldWindow } from '../held-window.ts';
import { type DigestEvent, type DigestItem, digestOf } from './digest.ts';
import type { MorningNews } from './morning.ts';
import {
  SESSIONS_NOT_COUNTED,
  type SessionMinutes,
  SessionRuns,
  type SessionTurn,
  sessionMinutesOf,
} from './session-minutes.ts';
import type { CoachEventKind } from './stream.ts';
import { type CoachReadiness, DAILY_EVENT_LIMIT, type MomentAnswer } from './types.ts';
import { type PlanBoardReading, type WeekPlan, weekPlanOf } from './week-plan.ts';

interface Addressed {
  /** The Coach board, which the frame is addressed on. */
  workspaceId: string;
  at: number;
}

export type SessionFrame = Addressed &
  (
    | {
        event: 'coach.event';
        kind: CoachEventKind;
        /** The board he was on, by id and name. */
        boardId: string;
        board?: string;
        docId?: string;
        doc?: string;
        heading?: string;
        text?: string;
      }
    | {
        event: 'coach.answer';
        momentId: string;
        answer: MomentAnswer;
        /** What he wrote with a thumbs down. */
        text?: string;
        goal: string;
        line: string;
      }
    | { event: 'coach.preference'; readiness: CoachReadiness }
    | {
        event: 'coach.morning';
        /** His local day, `YYYY-MM-DD`, and its weekday. No board: there is
         *  nothing in it for `coach/exclusion.ts` to exclude. */
        day: string;
        weekday: string;
      }
    | {
        event: 'coach.digest';
        from: number;
        to: number;
        items: DigestItem[];
        plan: WeekPlan;
        /** His Claude Code sessions in the window, repo and minutes only. */
        sessions: SessionMinutes[];
        /** What the sessions list cannot see, said once per digest. */
        sessionsNote: string;
      }
  );

/** A frame before it is addressed. */
export type SessionNews = SessionFrame extends infer F
  ? F extends Addressed
    ? Omit<F, keyof Addressed>
    : never
  : never;

export interface SessionFeedDeps {
  /** The Coach board and its lead, or null when there is no board or no lead. */
  lead: () => { workspaceId: string; agentId: string } | null;
  /** Sends one addressed frame; answers how many of the lead's streams took it. */
  send: (workspaceId: string, agentId: string, frame: SessionFrame) => number;
  /** Whether the lead is holding a stream on its board now. */
  connected: (workspaceId: string, agentId: string) => boolean;
  /** Events already sent on `at`'s local day. */
  eventsOn: (at: number) => number;
  /** Turns a day; defaults to `DAILY_EVENT_LIMIT`. */
  dailyLimit?: number;
  /** A digest or the morning wake-up reached the session: one turn spent. */
  countTurn: (at: number) => void;
  /** Team Lead's plan board (`review-plan.ts`), read as each digest goes. */
  planBoard: () => PlanBoardReading | undefined;
  /** The owner's zone, which decides the day a week starts on. */
  timeZone: () => string;
  now?: () => number;
  /** Runs `fn` after `ms`; answers a cancel. Defaults to an unref'd timer. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/** How long a window stays open before it goes as one digest. */
export const DIGEST_WINDOW_MS = 15 * 60_000;

/** Where a session's mark came from, before any time is credited. */
export type SessionTurnNews = Omit<SessionTurn, 'creditMs' | 'kind'>;

type Held = { event: DigestEvent } | { turn: SessionTurn };

export class SessionFeed {
  private readonly window: HeldWindow<Held>;

  private readonly runs = new SessionRuns();

  constructor(private readonly deps: SessionFeedDeps) {
    this.window = new HeldWindow<Held>({
      windowMs: DIGEST_WINDOW_MS,
      close: (held, from, to) => this.close(held, from, to),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.schedule ? { schedule: deps.schedule } : {}),
    });
  }

  /** Whether a session would hear a frame sent now. */
  reachable(): boolean {
    const lead = this.deps.lead();
    return lead !== null && this.deps.connected(lead.workspaceId, lead.agentId);
  }

  /** The day's budget is spent: nothing more goes until tomorrow. */
  paused(at: number): boolean {
    return this.deps.eventsOn(at) >= (this.deps.dailyLimit ?? DAILY_EVENT_LIMIT);
  }

  /** An event joins the open window; anything else goes now. True when a
   *  session is there to take it. */
  send(news: SessionNews, at: number): boolean {
    if (news.event !== 'coach.event') return this.deliver(news, at);
    if (this.paused(at) || !this.reachable()) return false;
    const { event: _event, ...e } = news;
    this.window.hold({ event: { ...e, at } });
    return true;
  }

  /** The morning wake-up: one turn of the budget, counted like a digest.
   *  Never held: with no session there it is dropped. */
  wake(news: MorningNews, at: number): boolean {
    if (!this.deliver(news, at)) return false;
    this.deps.countTurn(at);
    return true;
  }

  /** A prompt in an attached session. A typed one opens a run and joins
   *  the window, opening one; an injected one ends the run. */
  prompt(news: SessionTurnNews, typed: boolean): boolean {
    this.runs.prompt(news.session, news.at, typed);
    if (!typed || this.paused(news.at) || !this.reachable()) return false;
    this.window.hold({ turn: { ...news, kind: 'prompt', creditMs: 0 } });
    return true;
  }

  /** A turn end counts only inside a run, and only joins a window already
   *  open. The run moves either way, so a later gap is still right. */
  turn(news: SessionTurnNews): boolean {
    const creditMs = this.runs.turnEnd(news.session, news.at);
    if (creditMs === null || !this.window.open()) return false;
    if (this.paused(news.at) || !this.reachable()) return false;
    this.window.hold({ turn: { ...news, kind: 'turn', creditMs } });
    return true;
  }

  /** Drops a window still open, sending nothing. */
  stop(): void {
    this.window.stop();
  }

  private close(held: Held[], from: number, at: number): void {
    const items = digestOf(
      held.flatMap((h) => ('event' in h ? [h.event] : [])),
      at,
    );
    const sessions = sessionMinutesOf(held.flatMap((h) => ('turn' in h ? [h.turn] : [])));
    if (items.length === 0 && sessions.length === 0) return;
    const plan = weekPlanOf(this.deps.planBoard(), at, this.deps.timeZone());
    const digest = {
      event: 'coach.digest' as const,
      from,
      to: at,
      items,
      plan,
      sessions,
      sessionsNote: SESSIONS_NOT_COUNTED,
    };
    if (this.deliver(digest, at)) {
      this.deps.countTurn(at);
    }
  }

  private deliver(news: SessionNews, at: number): boolean {
    if (this.paused(at)) return false;
    const lead = this.deps.lead();
    if (!lead || !this.deps.connected(lead.workspaceId, lead.agentId)) return false;
    const frame = { ...news, workspaceId: lead.workspaceId, at } as SessionFrame;
    return this.deps.send(lead.workspaceId, lead.agentId, frame) > 0;
  }
}
