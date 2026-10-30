/**
 * The lead chat: one conversation per board between the people on it and the
 * board's lead agent, reached from the agent button on every workspace page.
 *
 * In `core` because both ends read it. The server keeps the log
 * (`server/src/lead-chat/`) and answers `GET` and `POST
 * /workspaces/<ws>/lead-chat`; every change goes to the board's open pages as
 * a `lead-chat.changed` frame on `/workspaces/<ws>/events:stream`, carrying
 * the message whole, so a page upserts it by id and needs no second read.
 */

/** The board-stream event a changed message rides. */
export const LEAD_CHAT_EVENT = 'lead-chat.changed';

/** The longest message a person may send, in characters. */
export const LEAD_CHAT_MAX_CHARS = 4000;

/**
 * What became of a person's message.
 *
 * - `sent`: on the lead's stream now.
 * - `queued`: the lead holds no stream; it reads the message when it is back.
 * - `answered`: the lead replied.
 * - `no-lead`: the board has no lead, so nobody was sent it.
 */
export type LeadChatState = 'sent' | 'queued' | 'answered' | 'no-lead';

export interface LeadChatMessage {
  id: string;
  /** `person`: someone on the board. `agent`: the lead. */
  role: 'person' | 'agent';
  author: { id: string; name: string };
  text: string;
  ts: number;
  /** How a person's message was made: typed, or said to the lead. */
  via?: 'chat' | 'voice';
  /** On a person's message only. */
  state?: LeadChatState;
  /** On an agent's message: the person's message it answers. */
  replyTo?: string;
}

export interface LeadChatLead {
  agentId: string;
  name: string;
}

export interface LeadChatSnapshot {
  lead: LeadChatLead | null;
  messages: LeadChatMessage[];
  /** The meeting this chat is running, or null. Absent from a server built
   *  before meetings, which reads as none. */
  meeting?: LeadChatMeeting | null;
}

/**
 * Where a lead-chat meeting's notes go: a doc the person picked, a doc made
 * for it, or nowhere. `none` still records — the lead hears "Lead, …" and
 * the transcript is kept — but no note-taker writes.
 */
export type LeadChatNotesKind = 'existing' | 'new' | 'none';

/** What the meeting records: this device's microphone, the microphone plus
 *  this Mac's audio, or a bot sent into a call. */
export type LeadChatMeetingSource = 'mic' | 'mix' | 'bot';

/** One line said in the meeting, as the chat's live notes show it. */
export interface LeadChatMeetingLine {
  /** The recording's turn number; a later line with the same turn replaces
   *  the earlier one. */
  turn: number;
  who: string;
  text: string;
  ts: number;
}

/**
 * A meeting started from the lead chat. It belongs to the board, not to a
 * page: every page of the board shows it, the page holding the microphone
 * resumes it after a move (`recorder`), and End meeting on any of them ends
 * it.
 */
export interface LeadChatMeeting {
  id: string;
  startedAt: number;
  by: { id: string; name: string };
  /** The doc the meeting records on — its notes doc unless `notes` is
   *  `none`. The server may move it once, when the note-taker hands a
   *  person's own doc off to a notes doc of its own. */
  docId: string;
  docTitle: string;
  notes: LeadChatNotesKind;
  source: LeadChatMeetingSource;
  speakers: 'solo' | 'conversation';
  /** Which browser holds the microphone: a token the page keeps in its own
   *  storage, so a page move on that device resumes the recording and a
   *  page on any other device only shows it. */
  recorder: string;
  /** The recording's own id, once the server has opened it: what a page
   *  move offers back as `resume`. */
  meetingId?: string;
  /** Who is in it, for the heading's faces. */
  people: Array<{ id: string; name: string }>;
  /** The last `LEAD_CHAT_MEETING_LINES` final lines, oldest first. */
  lines: LeadChatMeetingLine[];
}

/** How many lines a meeting keeps for the live notes. */
export const LEAD_CHAT_MEETING_LINES = 200;

/** The board-stream event a meeting's change rides: the meeting whole, or
 *  null when it ended. */
export const LEAD_CHAT_MEETING_EVENT = 'lead-chat.meeting';

export interface LeadChatMeetingFrame {
  event: typeof LEAD_CHAT_MEETING_EVENT;
  workspaceId: string;
  meeting: LeadChatMeeting | null;
}

/** The board-stream event one line said in a meeting rides, so the live
 *  notes on every page grow without the meeting being sent again whole. */
export const LEAD_CHAT_MEETING_LINE_EVENT = 'lead-chat.meeting-line';

export interface LeadChatMeetingLineFrame {
  event: typeof LEAD_CHAT_MEETING_LINE_EVENT;
  workspaceId: string;
  /** The meeting's `id`; a page showing another meeting ignores the line. */
  meeting: string;
  line: LeadChatMeetingLine;
}

/** Put a line into a meeting's lines by turn, oldest first, keeping the last
 *  `LEAD_CHAT_MEETING_LINES`. */
export function upsertMeetingLine(
  lines: readonly LeadChatMeetingLine[],
  line: LeadChatMeetingLine,
): LeadChatMeetingLine[] {
  const out = lines.filter((l) => l.turn !== line.turn);
  out.push(line);
  out.sort((a, b) => a.turn - b.turn);
  return out.slice(-LEAD_CHAT_MEETING_LINES);
}

/**
 * Whether a line said in a meeting is addressed to the lead: it opens with
 * "Lead," (or "Lead:"), as "Lead, file a task…" does. Everything else is the
 * room talking, and only the note-taker hears it.
 *
 * The comma is required. "Lead the way" and "lead time is two weeks" are a
 * room talking, and the transcribers this runs on punctuate a name used to
 * address someone.
 */
export function addressesLead(text: string): boolean {
  return /^\s*lead\s*[,:]\s*\S/i.test(text);
}

/** `GET /workspaces/<ws>/lead-chat`: the snapshot, and whether this reader
 *  may write to the lead (the owner alone may). */
export interface LeadChatRead extends LeadChatSnapshot {
  canTalk: boolean;
}

/** One `lead-chat.changed` frame. */
export interface LeadChatFrame {
  event: typeof LEAD_CHAT_EVENT;
  workspaceId: string;
  message: LeadChatMessage;
}

const STATES: readonly string[] = ['sent', 'queued', 'answered', 'no-lead'];

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

/** A message off the wire or out of the log, or null when it is not one. */
export function parseLeadChatMessage(raw: unknown): LeadChatMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const id = str(m.id, 200);
  const text = str(m.text, LEAD_CHAT_MAX_CHARS * 2);
  const a = m.author as Record<string, unknown> | undefined;
  const authorId = str(a?.id, 200);
  const authorName = str(a?.name, 200);
  if (!id || !text || !authorId || !authorName) return null;
  if (m.role !== 'person' && m.role !== 'agent') return null;
  if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) return null;
  const state = typeof m.state === 'string' && STATES.includes(m.state) ? m.state : undefined;
  const replyTo = str(m.replyTo, 200);
  return {
    id,
    role: m.role,
    author: { id: authorId, name: authorName },
    text,
    ts: m.ts,
    ...(m.via === 'chat' || m.via === 'voice' ? { via: m.via } : {}),
    ...(state ? { state: state as LeadChatState } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
}

/**
 * Put `m` into `list` by id, keeping the list in time order. A message seen
 * twice — the POST's answer and its own frame — is one row.
 */
export function upsertLeadChatMessage(
  list: readonly LeadChatMessage[],
  m: LeadChatMessage,
): LeadChatMessage[] {
  const out = list.filter((x) => x.id !== m.id);
  out.push(m);
  out.sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return out;
}
