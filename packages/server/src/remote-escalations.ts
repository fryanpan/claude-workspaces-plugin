/**
 * A dead board on ANOTHER server, told to this server's Team Lead.
 *
 * `stall-escalation.ts` tells Team Lead about a board nobody is on, but only
 * on the server that holds the board: it looks for Team Lead's stream among
 * that server's own boards. A lead on a project machine has its board on the
 * machine's server, and Team Lead's stream is on the Mac, so that search
 * finds nobody and the machine files its last-resort item for the owner.
 * Team Lead, the one party that can restart the lead, hears nothing.
 *
 * The Mac already pulls every remote board's home feed (`home-remotes.ts`),
 * and the machine announces a change on Home whenever the escalation its
 * feed reports appears, changes or goes (`onDeadBoardChange` in
 * `stall-escalation.ts`), so the Mac re-reads the feed then. The feed
 * carries the escalation as numbers and one agent id (`HomeFeedEscalation`,
 * checked by `readEscalation`); this module turns it into a stall frame for
 * Team Lead on whichever board here Team Lead holds a stream. No server
 * calls the Mac: the pull stays a pull.
 *
 * **No remote words in the frame.** The board id and origin come from the
 * Mac's own routing table; the lead id is one token of at most 200
 * characters that the server's own agent-id rule accepts, with no
 * whitespace, slash or control character, though the remote chose it; the
 * rest are two numbers. The board's name and its rows are the
 * remote's text, which Home draws escaped for a person but which would reach
 * an agent as instructions, so they stay out.
 *
 * **Once per dead stretch.** The record is keyed by the board and the
 * remote's `deadSince`: the same stretch is told once, a board that dies
 * again is told again, and a board whose feed stops carrying an escalation
 * is forgotten. A board the Mac could not reach keeps its record untouched,
 * since its view holds the last rows read. Memory only: a Mac restart tells
 * Team Lead once more about a board still dead, which costs one turn.
 *
 * **The board is told Team Lead has it.** Once Team Lead has heard about a
 * stretch, and every five minutes while Team Lead stays reachable here, the
 * Mac says so to the board's server (`acknowledge`, `POST
 * …/home-feed/escalation-ack`), and that server files no owner item while
 * the word is fresh (`REMOTE_HOLD_MS` in `stall-escalation.ts`). If Team Lead
 * goes, the word stops and the owner is asked there. This is the only call
 * the Mac makes for it, and it goes to the server it already pulls.
 */
import type { HomeFeedEscalation } from './home-feed.ts';
import type { RemoteBoardView } from './home-remotes.ts';
import type { TeamLeadReach } from './stall-escalation.ts';
import { STALL_EVENT } from './stall-nudge.ts';

/** How often the Mac repeats that Team Lead holds a remote board. A third of
 *  the board's `REMOTE_HOLD_MS`, so one lost call does not lapse the hold. */
export const REMOTE_ACK_REFRESH_MS = 5 * 60_000;

/** What Team Lead is sent: the board it is about, the seat nobody holds,
 *  and where the board lives. The MCP renders `remote` with its own remedy
 *  (`nudge-line.ts`): attaching here cannot reach that board. */
export interface RemoteStallFrame {
  event: typeof STALL_EVENT;
  workspaceId: string;
  escalatedFrom?: string;
  remote: { origin: string; deadSince: number; stuck: number };
  ts: number;
}

/** The same reach `stall-escalation.ts` uses, sending this frame instead. */
export type RemoteReach = Omit<TeamLeadReach, 'send'> & {
  send: (workspaceId: string, agentId: string, frame: RemoteStallFrame) => number;
};

export interface RemoteEscalationsOptions {
  teamLead: RemoteReach;
  /** The origin hostname the routing table says holds a board, or undefined
   *  for a board it does not list. */
  originOf: (boardId: string) => string | undefined;
  /** Tell the board's server Team Lead here holds its stretch; true when it
   *  took the word. Absent → the board files for its owner as before. */
  acknowledge?: (boardId: string, deadSince: number) => Promise<boolean>;
  report?: (message: string) => void;
}

export class RemoteEscalations {
  /** Board id → the dead stretch already told, by its `deadSince`. */
  private readonly told = new Map<string, number>();
  /** Board id → the stretch last acknowledged to its server, and when. */
  private readonly acked = new Map<string, { deadSince: number; at: number }>();
  private readonly acking = new Set<string>();
  private readonly report: (message: string) => void;

  constructor(private readonly opts: RemoteEscalationsOptions) {
    this.report = opts.report ?? ((message) => console.error(message));
  }

  /** One pass over every remote board. Never throws. */
  observe(views: readonly RemoteBoardView[], now: number): void {
    for (const view of views) {
      try {
        this.one(view, now);
      } catch (err) {
        console.error('[stall] remote escalation failed:', err);
      }
    }
  }

  private one(view: RemoteBoardView, now: number): void {
    if (view.reached !== true) return;
    const esc = view.escalation;
    if (!esc) {
      this.told.delete(view.boardId);
      this.acked.delete(view.boardId);
      return;
    }
    if (this.told.get(view.boardId) !== esc.deadSince) {
      const origin = this.opts.originOf(view.boardId);
      if (origin === undefined) return;
      if (!this.send(view.boardId, origin, esc, now)) return;
      this.told.set(view.boardId, esc.deadSince);
    }
    this.acknowledge(view.boardId, esc.deadSince, now);
  }

  /** Say Team Lead holds the stretch, while it can still be reached here. */
  private acknowledge(boardId: string, deadSince: number, now: number): void {
    const ack = this.opts.acknowledge;
    if (!ack || this.acking.has(boardId) || this.teamLeadBoard() === undefined) return;
    const last = this.acked.get(boardId);
    if (last?.deadSince === deadSince && now - last.at < REMOTE_ACK_REFRESH_MS) return;
    this.acking.add(boardId);
    ack(boardId, deadSince)
      .then((held) => {
        if (held) this.acked.set(boardId, { deadSince, at: now });
      })
      .catch(() => {})
      .finally(() => this.acking.delete(boardId));
  }

  private teamLeadBoard(): string | undefined {
    const reach = this.opts.teamLead;
    return reach.boards().find((id) => reach.canReach(id, reach.agentId));
  }

  private send(boardId: string, origin: string, esc: HomeFeedEscalation, now: number): boolean {
    const reach = this.opts.teamLead;
    const on = this.teamLeadBoard();
    if (on === undefined) return false;
    const frame: RemoteStallFrame = {
      event: STALL_EVENT,
      workspaceId: boardId,
      ...(esc.lead !== undefined ? { escalatedFrom: esc.lead } : {}),
      remote: { origin, deadSince: esc.deadSince, stuck: esc.stuck },
      ts: now,
    };
    const delivered = reach.send(on, reach.agentId, frame);
    if (delivered > 0) {
      this.report(
        `[stall] escalated remote ws=${boardId} origin=${origin} rows=${esc.stuck} to=${reach.agentId} on=${on}`,
      );
    }
    return delivered > 0;
  }
}
