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
 * With no lead, or a lead holding no stream, what he does is still held:
 * a window that closes then waits on disk (`coach/backlog.ts`), and when
 * the session's stream comes back every waiting window goes as one digest,
 * one turn. A restart keeps the window that was open. His answers, his
 * setting and the morning wake-up are not held: each is about now, and a
 * session that is gone has nothing to do with it later.
 *
 * Each prompt and turn end that carried text is said in a few words before
 * the digest goes (`coach/summary.ts`); that call never holds a digest back.
 */
import { HeldWindow } from '../held-window.ts';
import type { CoachBacklog, HeldDigest, HeldMark } from './backlog.ts';
import { type DigestItem, digestOf } from './digest.ts';
import type { MorningNews } from './morning.ts';
import {
  SESSIONS_NOT_COUNTED,
  type SessionMinutes,
  SessionRuns,
  type SessionTurn,
  sessionMinutesOf,
} from './session-minutes.ts';
import type { CoachEventKind } from './stream.ts';
import { type CoachSummarizer, summariseMarks } from './summary.ts';
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
        /** How many windows this digest carries, when the session was away
         *  for more than one. */
        windows?: number;
        /** Windows dropped while it was away, past the backlog's bounds. */
        dropped?: number;
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
  /** Where closed windows wait for the session; none keeps them in memory
   *  only for as long as this feed lives. */
  backlog?: CoachBacklog;
  /** Says each prompt and turn in a few words; none uses their own words. */
  summarizer?: CoachSummarizer | null;
  /** How long a window stays open; defaults to `DIGEST_WINDOW_MS`. */
  windowMs?: number;
  now?: () => number;
  /** Runs `fn` after `ms`; answers a cancel. Defaults to an unref'd timer. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/** How long a window stays open before it goes as one digest. */
export const DIGEST_WINDOW_MS = 15 * 60_000;

/** Where a session's mark came from, before any time is credited. */
export type SessionTurnNews = Omit<SessionTurn, 'creditMs' | 'kind'>;

type Held = HeldMark;

export class SessionFeed {
  private readonly window: HeldWindow<Held>;

  private readonly runs = new SessionRuns();

  /** Closed windows when there is no backlog on disk. */
  private readonly memory: HeldDigest[] = [];
  private sending: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: SessionFeedDeps) {
    this.window = new HeldWindow<Held>({
      windowMs: deps.windowMs ?? DIGEST_WINDOW_MS,
      close: (held, from, to) => this.close(held, from, to),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.schedule ? { schedule: deps.schedule } : {}),
    });
    const interrupted = deps.backlog?.window;
    if (interrupted) this.window.resume(interrupted.items, interrupted.openedAt);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
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

  /** An event joins the open window, whether or not a session is there
   *  now; anything else goes now. True when it was held or taken. */
  send(news: SessionNews, at: number): boolean {
    if (news.event !== 'coach.event') return this.deliver(news, at);
    if (this.paused(at)) return false;
    const { event: _event, ...e } = news;
    this.hold({ event: { ...e, at } });
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
    if (!typed || this.paused(news.at)) return false;
    this.hold({ turn: { ...news, kind: 'prompt', creditMs: 0 } });
    return true;
  }

  /** A turn end counts only inside a run, and only joins a window already
   *  open. The run moves either way, so a later gap is still right. */
  turn(news: SessionTurnNews): boolean {
    const creditMs = this.runs.turnEnd(news.session, news.at);
    if (creditMs === null || !this.window.open()) return false;
    if (this.paused(news.at)) return false;
    this.hold({ turn: { ...news, kind: 'turn', creditMs } });
    return true;
  }

  /** The session's stream is back, or anything else that may let a waiting
   *  digest go. Never rejects. */
  reconnected(): Promise<void> {
    return this.trySend();
  }

  /** Settles once any digest being sent now has gone or failed. */
  idle(): Promise<void> {
    return this.sending ?? Promise.resolve();
  }

  /** Closes a window still open into the backlog and sends nothing more,
   *  so a restart reads it next time. */
  stop(): void {
    this.stopped = true;
    this.window.closeNow();
    this.deps.backlog?.flush();
  }

  private hold(mark: Held): void {
    this.window.hold(mark);
    this.deps.backlog?.noteWindow(this.window.snapshot(), this.now());
  }

  private close(held: Held[], from: number, at: number): void {
    const items = digestOf(
      held.flatMap((h) => ('event' in h ? [h.event] : [])),
      at,
    );
    const turns = held.flatMap((h) => ('turn' in h ? [h.turn] : []));
    const backlog = this.deps.backlog;
    if (items.length > 0 || turns.length > 0) {
      const digest = { from, to: at, items, turns };
      if (backlog) backlog.add(digest, at);
      else this.memory.push(digest);
    }
    backlog?.noteWindow(null, at, true);
    if (!this.stopped) void this.trySend();
  }

  private waiting(now: number): { digests: HeldDigest[]; dropped: number } {
    return this.deps.backlog?.waiting(now) ?? { digests: [...this.memory], dropped: 0 };
  }

  /** Every waiting window, as one digest, if a session is there to read it.
   *  Synchronous when nothing needs summarising. Never rejects. */
  private trySend(): Promise<void> {
    if (this.sending) return this.sending;
    if (this.stopped || !this.reachable() || this.paused(this.now())) return Promise.resolve();
    const { digests, dropped } = this.waiting(this.now());
    if (digests.length === 0) return Promise.resolve();
    const turns = digests.flatMap((d) => d.turns);
    const marked = turns.flatMap((t, i) => (t.text ? [{ i, kind: t.kind, text: t.text }] : []));
    const summarizer = this.deps.summarizer;
    if (!summarizer || marked.length === 0) {
      if (this.sendDigest(digests, dropped, turns, new Map())) return this.trySend();
      return Promise.resolve();
    }
    this.sending = summariseMarks(marked, summarizer).then((lines) => {
      this.sending = null;
      const summaryAt = new Map(marked.map((m, n) => [m.i, lines[n]]));
      // Windows that closed while this one was being summarised go next.
      if (this.sendDigest(digests, dropped, turns, summaryAt)) return this.trySend();
      return undefined;
    });
    return this.sending;
  }

  /** True when the session took it. */
  private sendDigest(
    digests: HeldDigest[],
    dropped: number,
    turns: SessionTurn[],
    summaryAt: Map<number, string | undefined>,
  ): boolean {
    if (this.stopped) return false;
    const at = this.now();
    const digest: SessionNews = {
      event: 'coach.digest',
      from: digests[0]?.from ?? at,
      to: digests[digests.length - 1]?.to ?? at,
      items: digests.flatMap((d) => d.items),
      plan: weekPlanOf(this.deps.planBoard(), at, this.deps.timeZone()),
      sessions: sessionMinutesOf(turns, (i) => summaryAt.get(i)),
      sessionsNote: SESSIONS_NOT_COUNTED,
      ...(digests.length > 1 ? { windows: digests.length } : {}),
      ...(dropped > 0 ? { dropped } : {}),
    };
    if (!this.deliver(digest, at)) return false;
    this.deps.countTurn(at);
    if (this.deps.backlog) this.deps.backlog.delivered(digests);
    else {
      const gone = new Set(digests);
      const kept = this.memory.filter((d) => !gone.has(d));
      this.memory.splice(0, this.memory.length, ...kept);
    }
    return true;
  }

  private deliver(news: SessionNews, at: number): boolean {
    if (this.paused(at)) return false;
    const lead = this.deps.lead();
    if (!lead || !this.deps.connected(lead.workspaceId, lead.agentId)) return false;
    const frame = { ...news, workspaceId: lead.workspaceId, at } as SessionFrame;
    return this.deps.send(lead.workspaceId, lead.agentId, frame) > 0;
  }
}
