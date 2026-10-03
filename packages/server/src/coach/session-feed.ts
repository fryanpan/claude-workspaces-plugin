/**
 * The coach session's feed: every event, as it happens, to the Claude Code
 * session that is the coach (the owner, 2026-10-03: "routing all events to a
 * long running Claude Code session ... that can hold an ongoing
 * conversation with context").
 *
 * The session is the lead of the Coach board, launched once and kept
 * running all week by the fleet's respawn. Each frame is one addressed
 * frame to it on that board: what he did (`coach.event`), how he answered a
 * moment (`coach.answer`), and how readily he wants it to speak up
 * (`coach.preference`). The session decides whether to speak, and raises a
 * moment through `POST /coach/moments`; nothing here waits on it.
 *
 * With no lead, or a lead holding no stream, nothing is sent: an addressed
 * frame is replayed to a stream that comes back, so a session that is gone
 * would otherwise read a backlog of stale events when it returns.
 */
import type { CoachEventKind } from './stream.ts';
import type { CoachReadiness, MomentAnswer } from './types.ts';

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
        answer: MomentAnswer | 'moved-on';
        goal: string;
        line: string;
      }
    | { event: 'coach.preference'; readiness: CoachReadiness }
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
}

export class SessionFeed {
  constructor(private readonly deps: SessionFeedDeps) {}

  /** Whether a session would hear a frame sent now. */
  reachable(): boolean {
    const lead = this.deps.lead();
    return lead !== null && this.deps.connected(lead.workspaceId, lead.agentId);
  }

  /** Send it now. True when the session's stream took it. */
  send(news: SessionNews, at: number): boolean {
    const lead = this.deps.lead();
    if (!lead || !this.deps.connected(lead.workspaceId, lead.agentId)) return false;
    const frame = { ...news, workspaceId: lead.workspaceId, at } as SessionFrame;
    return this.deps.send(lead.workspaceId, lead.agentId, frame) > 0;
  }
}
