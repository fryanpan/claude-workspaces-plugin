/**
 * The meeting a board's lead chat is running: at most one per board, and it
 * belongs to the board rather than to the page it was started on.
 *
 * The recording itself is the doc meeting every other surface runs — the
 * `/audio` socket, the relay, the transcript and the note-taker
 * (`meeting-protocol.ts`). What this adds is the part no doc holds: which doc
 * the notes go to, which browser holds the microphone (so a page move on that
 * device resumes the same recording), who is in it, and the lines said so
 * far, so every page of the board shows the live notes and End meeting works
 * from any of them.
 *
 * Kept in one small file per board, written whole on every change, so a
 * server restart in the middle of a meeting comes back to the same meeting
 * and the page holding the microphone resumes it. The lines are a copy for
 * the screen; the transcript the relay keeps is the record. An ended meeting
 * is written as ended rather than removed.
 *
 * Every change goes to the board's pages only, as the chat's messages do.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  LEAD_CHAT_MEETING_EVENT,
  LEAD_CHAT_MEETING_LINE_EVENT,
  type LeadChatMeeting,
  type LeadChatMeetingFrame,
  type LeadChatMeetingLine,
  type LeadChatMeetingLineFrame,
  type LeadChatMeetingSource,
  type LeadChatNotesKind,
  leadLineTurn,
  upsertMeetingLine,
} from '@claude-workspaces/core/lead-chat';

/** Board ids are the server's own (`w-…`); anything else never names a file. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** How many faces a meeting keeps. The heading shows four. */
const PEOPLE_MAX = 12;

export function leadChatMeetingPath(dataDir: string, workspaceId: string): string | null {
  if (!SAFE_ID.test(workspaceId)) return null;
  return join(dataDir, 'workspaces', `${workspaceId}.lead-chat-meeting.json`);
}

/**
 * Whether a line said in the meeting may reach the lead as the owner's ask.
 *
 * The lead acts on it as the owner, so the line has to be the owner's own
 * words, and the gate is the one a doc meeting's "Claude, …" already passes
 * (docs/architecture/security.md): the request carries a person proof that
 * names the owner, and the words came from this device's microphone alone.
 * Never a bot's call, where any guest may speak, and never Mac audio, where
 * the far side of a call is in the stream. On the microphone, anyone in the
 * room counts as the owner, as there.
 */
export function leadHearsLine(source: LeadChatMeetingSource, ownerProven: boolean): boolean {
  return ownerProven && source === 'mic';
}

/** How long after the lead says a line the room's microphone may hand it
 *  back: the voice's own length plus the transcriber settling the turn. */
export const LEAD_ECHO_MS = 30_000;

/** Lower case, letters and digits only, single spaces. */
function spoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Whether a line heard in the room is the lead's own voice coming back
 * through the microphone: its words equal, or are a part of, a line the lead
 * said in the last `LEAD_ECHO_MS`. Mac audio records what the machine plays
 * with no echo cancellation, and even a cancelling microphone leaks; fed back,
 * the lead would read its own words as the room's and could answer them.
 * A part must be 12 characters or more, so "yes" is never taken for an echo.
 */
export function echoOfLead(
  lines: readonly LeadChatMeetingLine[],
  text: string,
  now: number,
): boolean {
  const heard = spoken(text);
  if (!heard) return false;
  return lines.some((l) => {
    if (!l.lead || now - l.ts > LEAD_ECHO_MS) return false;
    const said = spoken(l.text);
    return said === heard || (heard.length >= 12 && said.includes(heard));
  });
}

export interface MeetingStart {
  by: { id: string; name: string };
  docId: string;
  docTitle: string;
  notes: LeadChatNotesKind;
  source: LeadChatMeetingSource;
  speakers: 'solo' | 'conversation';
  recorder: string;
}

export type MeetingChange = { ok: true; meeting: LeadChatMeeting } | { ok: false; error: string };

export interface LeadChatMeetingsDeps {
  dataDir: string;
  broadcast(workspaceId: string, frame: LeadChatMeetingFrame | LeadChatMeetingLineFrame): void;
  newId(): string;
  now?: () => number;
}

export class LeadChatMeetings {
  private readonly held = new Map<string, LeadChatMeeting | null>();
  private readonly now: () => number;

  constructor(private readonly deps: LeadChatMeetingsDeps) {
    this.now = deps.now ?? Date.now;
  }

  current(workspaceId: string): LeadChatMeeting | null {
    if (this.held.has(workspaceId)) return this.held.get(workspaceId) ?? null;
    const m = this.read(workspaceId);
    this.held.set(workspaceId, m);
    return m;
  }

  start(workspaceId: string, s: MeetingStart): MeetingChange {
    if (this.current(workspaceId)) return { ok: false, error: 'meeting-running' };
    const meeting: LeadChatMeeting = {
      id: this.deps.newId(),
      startedAt: this.now(),
      by: { ...s.by },
      docId: s.docId,
      docTitle: s.docTitle,
      notes: s.notes,
      source: s.source,
      speakers: s.speakers,
      recorder: s.recorder,
      people: [{ ...s.by }],
      lines: [],
    };
    return this.save(workspaceId, meeting);
  }

  /** The recording opened, resumed, or moved to a notes doc of its own. */
  recording(
    workspaceId: string,
    id: string,
    r: { meetingId: string; recorder: string; docId?: string; docTitle?: string },
  ): MeetingChange {
    const m = this.current(workspaceId);
    if (!m || m.id !== id) return { ok: false, error: 'no-meeting' };
    return this.save(workspaceId, {
      ...m,
      meetingId: r.meetingId,
      recorder: r.recorder,
      ...(r.docId ? { docId: r.docId } : {}),
      ...(r.docTitle ? { docTitle: r.docTitle } : {}),
    });
  }

  /** Someone opened a page of the board while the meeting runs. */
  join(workspaceId: string, id: string, person: { id: string; name: string }): MeetingChange {
    const m = this.current(workspaceId);
    if (!m || m.id !== id) return { ok: false, error: 'no-meeting' };
    if (m.people.some((p) => p.id === person.id)) return { ok: true, meeting: m };
    if (m.people.length >= PEOPLE_MAX) return { ok: true, meeting: m };
    return this.save(workspaceId, { ...m, people: [...m.people, { ...person }] });
  }

  /**
   * One final line, from the page holding the microphone. `fresh` is false
   * for a turn the meeting already holds — a revision, or the same line sent
   * twice across a reconnect — which is what keeps a "Lead, …" line from
   * reaching the lead twice.
   */
  line(
    workspaceId: string,
    id: string,
    l: Omit<LeadChatMeetingLine, 'ts'>,
  ):
    | { ok: true; line: LeadChatMeetingLine; fresh: boolean; echo?: true }
    | { ok: false; error: string } {
    const m = this.current(workspaceId);
    if (!m || m.id !== id) return { ok: false, error: 'no-meeting' };
    // The room's microphone heard the lead's own voice: not a line.
    if (!l.lead && echoOfLead(m.lines, l.text, this.now())) {
      return { ok: true, line: { ...l, ts: this.now() }, fresh: false, echo: true };
    }
    const fresh = !m.lines.some((x) => x.turn === l.turn);
    const line: LeadChatMeetingLine = { ...l, ts: this.now() };
    const next = { ...m, lines: upsertMeetingLine(m.lines, line) };
    if (!this.write(workspaceId, next)) return { ok: false, error: 'write-failed' };
    this.held.set(workspaceId, next);
    this.deps.broadcast(workspaceId, {
      event: LEAD_CHAT_MEETING_LINE_EVENT,
      workspaceId,
      meeting: id,
      line,
    });
    return { ok: true, line, fresh };
  }

  /**
   * A line the board's lead says into the running meeting. It takes the turn
   * after the last line (`leadLineTurn`), shows on every page like any line,
   * and the page holding the microphone plays it.
   */
  said(
    workspaceId: string,
    who: string,
    text: string,
  ):
    | { ok: true; meeting: LeadChatMeeting; line: LeadChatMeetingLine }
    | { ok: false; error: string } {
    const m = this.current(workspaceId);
    if (!m) return { ok: false, error: 'no-meeting' };
    const turn = leadLineTurn(m.lines);
    if (turn === null) return { ok: false, error: 'room-first' };
    const r = this.line(workspaceId, m.id, { turn, who, text, lead: true });
    return r.ok ? { ok: true, meeting: m, line: r.line } : r;
  }

  end(workspaceId: string, id: string): MeetingChange {
    const m = this.current(workspaceId);
    if (!m || m.id !== id) return { ok: false, error: 'no-meeting' };
    const path = leadChatMeetingPath(this.deps.dataDir, workspaceId);
    if (!path || !this.writeFile(path, { meeting: null, ended: { ...m, endedAt: this.now() } })) {
      return { ok: false, error: 'write-failed' };
    }
    this.held.set(workspaceId, null);
    this.deps.broadcast(workspaceId, {
      event: LEAD_CHAT_MEETING_EVENT,
      workspaceId,
      meeting: null,
    });
    return { ok: true, meeting: m };
  }

  private save(workspaceId: string, meeting: LeadChatMeeting): MeetingChange {
    if (!this.write(workspaceId, meeting)) return { ok: false, error: 'write-failed' };
    this.held.set(workspaceId, meeting);
    this.deps.broadcast(workspaceId, { event: LEAD_CHAT_MEETING_EVENT, workspaceId, meeting });
    return { ok: true, meeting };
  }

  private write(workspaceId: string, meeting: LeadChatMeeting): boolean {
    const path = leadChatMeetingPath(this.deps.dataDir, workspaceId);
    return path !== null && this.writeFile(path, { meeting });
  }

  /** Whole, through a rename, so a crash leaves the last good copy. */
  private writeFile(path: string, body: unknown): boolean {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(body));
      renameSync(tmp, path);
      return true;
    } catch (err) {
      console.error(`[lead-chat] could not write the meeting at ${path}: ${String(err)}`);
      return false;
    }
  }

  private read(workspaceId: string): LeadChatMeeting | null {
    const path = leadChatMeetingPath(this.deps.dataDir, workspaceId);
    if (!path || !existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { meeting?: LeadChatMeeting | null };
      const m = raw.meeting;
      return m && typeof m.id === 'string' && Array.isArray(m.lines) ? m : null;
    } catch (err) {
      console.error(`[lead-chat] could not read ${workspaceId}'s meeting: ${String(err)}`);
      return null;
    }
  }
}
