/**
 * The board's lead in the meeting its lead chat runs: told once when the
 * meeting starts, then sent what the room settles, so it can follow along,
 * read the doc and research while people talk, and speak when it has
 * something (`say_in_meeting`, the `say` route in
 * `routes/workspace-lead-chat.ts`).
 *
 * Every other meeting event stays off agent streams (`channel-gate.ts` in
 * the MCP drops `meeting.*` whole). These two events are named in the
 * `voice.` family instead, so that gate lets them through and the self-echo
 * check reads their top-level `actor`, the person who started the meeting.
 *
 * LINES ARE BATCHED. Each frame costs the lead's session a turn, and a room
 * settles a short turn every second or two. So a line opens a window of
 * `LEAD_MEETING_BATCH_MS`, every line settled inside it rides the same
 * frame, and the frame goes when the window closes: a line reaches the lead
 * at most that long after it settled. Ending the meeting sends what is held
 * at once.
 *
 * The start is buffered for replay like any addressed frame, so a lead whose
 * stream blinked still learns a meeting began. The lines are TRANSIENT: a
 * reconnect replays nothing of them, because word-rate frames in the board's
 * 200-event replay buffer would push out every event a lead acts on (the
 * same reason `meeting-protocol.ts` keeps words off the doc's bus). A lead
 * that missed lines reads the meeting's doc.
 *
 * The lines are what anyone in the room said, and a bot meeting carries
 * every guest on the call. The MCP renders them inside an untrusted quote
 * (`meeting-feed-line.ts`): the lead reads them as what was said, never as
 * instructions. A request to the lead still goes through "Lead, …", which
 * checks for the owner's proof first.
 */
import type { TickScheduler } from '../pause-ticker.ts';

/** How long a line waits for others to ride with it. Under the 2s the lead
 *  is promised, and long enough to fold a run of short turns into one. */
export const LEAD_MEETING_BATCH_MS = 1_000;

export const LEAD_MEETING_STARTED_EVENT = 'voice.meeting_started';
export const LEAD_MEETING_HEARD_EVENT = 'voice.meeting_heard';

/** The most lines one frame carries; a longer run goes as several. */
const LINES_PER_FRAME = 40;

export interface FeedMeeting {
  id: string;
  docId: string;
  docTitle: string;
  by: { id: string; name: string };
}

export interface FeedLine {
  turn: number;
  who: string;
  text: string;
}

/** A frame to the lead: an event name and its fields. */
export type FeedFrame = { event: string } & Record<string, unknown>;

export interface LeadMeetingFeedDeps {
  /** The board's lead, or null when the seat is empty. */
  leadOf(workspaceId: string): string | null;
  /** One frame to the lead's own streams; `transient` frames are not kept
   *  for replay. How many streams took it. */
  send(workspaceId: string, agentId: string, frame: FeedFrame, transient: boolean): number;
  schedule: TickScheduler;
  now?: () => number;
}

interface Held {
  meeting: FeedMeeting;
  lines: FeedLine[];
  timer: unknown;
}

export class LeadMeetingFeed {
  private readonly held = new Map<string, Held>();
  private readonly now: () => number;

  constructor(private readonly deps: LeadMeetingFeedDeps) {
    this.now = deps.now ?? Date.now;
  }

  started(workspaceId: string, m: FeedMeeting): void {
    const lead = this.deps.leadOf(workspaceId);
    if (!lead) return;
    this.deps.send(
      workspaceId,
      lead,
      {
        event: LEAD_MEETING_STARTED_EVENT,
        workspaceId,
        meetingId: m.id,
        docId: m.docId,
        docTitle: m.docTitle,
        actor: { id: m.by.id, name: m.by.name },
        ts: this.now(),
      },
      false,
    );
  }

  /** A line the room settled. */
  heard(workspaceId: string, m: FeedMeeting, line: FeedLine): void {
    let h = this.held.get(workspaceId);
    if (!h || h.meeting.id !== m.id) {
      if (h) this.flush(workspaceId);
      h = { meeting: m, lines: [], timer: null };
      this.held.set(workspaceId, h);
    }
    h.lines.push({ turn: line.turn, who: line.who, text: line.text });
    if (h.timer === null) {
      h.timer = this.deps.schedule.set(() => this.flush(workspaceId), LEAD_MEETING_BATCH_MS);
    }
  }

  /** The meeting ended: what is held goes now. */
  ended(workspaceId: string): void {
    this.flush(workspaceId);
  }

  private flush(workspaceId: string): void {
    const h = this.held.get(workspaceId);
    if (!h) return;
    this.held.delete(workspaceId);
    if (h.timer !== null) this.deps.schedule.clear(h.timer);
    const lead = this.deps.leadOf(workspaceId);
    if (!lead || h.lines.length === 0) return;
    for (let i = 0; i < h.lines.length; i += LINES_PER_FRAME) {
      this.deps.send(
        workspaceId,
        lead,
        {
          event: LEAD_MEETING_HEARD_EVENT,
          workspaceId,
          meetingId: h.meeting.id,
          docId: h.meeting.docId,
          docTitle: h.meeting.docTitle,
          lines: h.lines.slice(i, i + LINES_PER_FRAME),
          actor: { id: h.meeting.by.id, name: h.meeting.by.name },
          ts: this.now(),
        },
        true,
      );
    }
  }
}
