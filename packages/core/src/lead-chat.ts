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
 * - `received`: the lead's session has it (its MCP child acked the row), and
 *   the lead is working until that session's turn ends.
 * - `done`: the turn that took it ended without an answer to this message.
 * - `answered`: the lead replied.
 * - `no-lead`: the board has no lead, so nobody was sent it.
 */
export type LeadChatState = 'sent' | 'queued' | 'received' | 'done' | 'answered' | 'no-lead';

/**
 * Where a message came from.
 *
 * - `chat`: typed into the board's chat.
 * - `voice`: said to the lead, on the page or in a meeting.
 * - `terminal`: typed into the lead's own Claude Code session, mirrored here
 *   by its UserPromptSubmit hook.
 * - `channel`: a board event the lead's session received as a prompt,
 *   mirrored the same way. Its `author` names who caused it.
 *
 * The last two are the mirror (`server/src/lead-chat/mirror.ts`): nothing in
 * them is sent to the lead again, and nothing in them is spoken. An agent's
 * message `via: 'terminal'` is the lead's session talking: text it wrote
 * mid-turn, or a tool call it made.
 */
export type LeadChatVia = 'chat' | 'voice' | 'terminal' | 'channel';

export interface LeadChatMessage {
  id: string;
  /** `person`: someone on the board, or a board event the lead received
   *  (`via: 'channel'`). `agent`: the lead. */
  role: 'person' | 'agent';
  author: { id: string; name: string };
  text: string;
  ts: number;
  /** How a person's message was made (`LeadChatVia`). */
  via?: LeadChatVia;
  /** On a person's message only. */
  state?: LeadChatState;
  /** On an agent's message: the person's message it answers. */
  replyTo?: string;
  /** On an agent's message: what its session showed when its turn ended,
   *  mirrored by the Stop hook. Shown, never spoken. */
  turnEnd?: true;
  /** On a person's message in `received`: when the lead's session took it,
   *  so a page can count how long it has been working. */
  receivedAt?: number;
  /** On an agent's message: a tool call the lead's session made, mirrored by
   *  its PostToolBatch hook. `text` is the call in one line. */
  tool?: LeadChatToolCall;
  /** On an agent's message: its session is still writing it, so its text
   *  grows. Kept out of the log until it is whole. */
  streaming?: true;
  /** On the lead's answer to something said aloud: `text` is the written
   *  part `answer_voice` gave, which nobody heard, so the chat shows it. */
  written?: true;
  /** On a person's message: the photos and files sent with it. A message
   *  with attachments may have no words. */
  attachments?: LeadChatAttachment[];
}

/**
 * A photo or file a person sent to the lead, as the server stored it
 * (`server/src/lead-chat/files.ts`). The server read `type` and `image` off
 * the bytes; neither comes from the browser.
 */
export interface LeadChatAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  /** A raster image, which a page draws as a thumbnail. */
  image?: true;
}

/** The largest photo or file one upload may be: a long phone video is
 *  refused, and a phone photo or a large PDF fits. */
export const LEAD_CHAT_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** The most photos and files one message may carry. */
export const LEAD_CHAT_FILES_PER_MESSAGE = 8;
const FILE_NAME_MAX = 160;
const FILE_TYPE_MAX = 100;
/** A stored file's id: `cryptoId('lf')`. */
export const LEAD_CHAT_FILE_ID = /^lf-[A-Za-z0-9_-]{8,40}$/;

/**
 * The models and efforts the board may switch a lead to. These two lists are
 * all that can ever reach the lead's terminal (`server/src/lead-chat/pane.ts`):
 * a page sends an alias or a level, and anything else is refused.
 */
export const LEAD_MODELS = [
  { alias: 'fable', label: 'Fable 5.1', note: 'For the hardest, longest work' },
  { alias: 'opus', label: 'Opus 5.5', note: 'Most capable for hard work' },
  { alias: 'sonnet', label: 'Sonnet 5.5', note: 'Fast and capable for everyday work' },
  { alias: 'haiku', label: 'Haiku 5.5', note: 'Fastest for quick answers' },
] as const;
export type LeadModelAlias = (typeof LEAD_MODELS)[number]['alias'];

export const LEAD_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type LeadEffort = (typeof LEAD_EFFORTS)[number];

export const isLeadModelAlias = (v: unknown): v is LeadModelAlias =>
  LEAD_MODELS.some((m) => m.alias === v);
export const isLeadEffort = (v: unknown): v is LeadEffort => LEAD_EFFORTS.includes(v as LeadEffort);

/** Why a switch did not happen. */
export type LeadModelProblem =
  | 'no-terminal' // no tmux here, or no pane runs this board's lead
  | 'many-terminals' // more than one does, so the board will not guess
  | 'asking' // the terminal is waiting on an answer; retried when the turn ends
  | 'send-failed';

/** What the board knows of its lead's model and effort. */
export interface LeadModelState {
  /** A model id its session reported. */
  model?: string;
  effort?: string;
  /** A pick an older server left on disk. It is dropped unsent
   *  (`server/src/lead-chat/lead-model.ts`), and no chip shows it. */
  pending?: { model?: LeadModelAlias; effort?: LeadEffort };
  problem?: LeadModelProblem;
}

/** The board-stream event a change to that rides. Pages only. */
export const LEAD_CHAT_MODEL_EVENT = 'lead-chat.model';

export interface LeadChatModelFrame {
  event: typeof LEAD_CHAT_MODEL_EVENT;
  workspaceId: string;
  state: LeadModelState;
}

/** "Opus 5.5" for `opus` or `claude-opus-5-5`; null for a name it cannot read. */
export function leadModelLabel(model: string | undefined): string | null {
  if (!model) return null;
  const known = LEAD_MODELS.find((m) => m.alias === model);
  if (known) return known.label;
  const m = model.match(/^claude-(fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?:\D|-|$)/);
  if (!m) return null;
  const family = (m[1] ?? '').replace(/^./, (c) => c.toUpperCase());
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** Where a page and an MCP child read a stored file. */
export function leadChatFilePath(workspaceId: string, fileId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/lead-chat/files/${encodeURIComponent(fileId)}`;
}

/** A tool call as the lead's terminal shows it, reduced by the hook the way
 *  a turn note is and capped. */
export interface LeadChatToolCall {
  name: string;
  input: string;
  output?: string;
  /** The call failed. */
  failed?: true;
}

/** The most of a tool call's input and output a message carries. */
export const LEAD_CHAT_TOOL_INPUT_MAX = 2000;
export const LEAD_CHAT_TOOL_OUTPUT_MAX = 4000;

export interface LeadChatLead {
  agentId: string;
  name: string;
}

export interface LeadChatSnapshot {
  lead: LeadChatLead | null;
  /** The latest `LEAD_CHAT_PAGE` messages, oldest first. */
  messages: LeadChatMessage[];
  /** Older messages exist: page back with `LeadChatHistoryPage`. Absent
   *  from a server built before paging, which reads as none. */
  more?: boolean;
  /** The meeting this chat is running, or null. Absent from a server built
   *  before meetings, which reads as none. */
  meeting?: LeadChatMeeting | null;
  /** The lead's model and effort. Absent from a server built before the
   *  picker, which reads as unknown. */
  leadModel?: LeadModelState;
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
  /** Said by the board's lead (`say_in_meeting`), not heard from the room.
   *  The page holding the microphone plays it aloud. */
  lead?: true;
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

/** The smallest gap a lead line may take before the room's next turn: ten
 *  lead lines in a row with nobody in the room speaking between them. */
export const LEAD_LINE_MIN_GAP = 1 / 1024;

/**
 * The turn a line the lead says takes: just after the last line, and still
 * before the room's next turn, which is the next whole number. Each further
 * lead line halves the gap that is left. Null once that gap would fall below
 * `LEAD_LINE_MIN_GAP`: halving further would, after about fifty lines, round
 * to the next whole number and replace the room's line there.
 */
export function leadLineTurn(lines: readonly LeadChatMeetingLine[]): number | null {
  const top = lines.reduce((m, l) => Math.max(m, l.turn), -1);
  const whole = Math.floor(top);
  const gap = (whole + 1 - top) / 2;
  return gap < LEAD_LINE_MIN_GAP ? null : top + gap;
}

/**
 * Whether a line said in a meeting is addressed to the lead: it opens with a
 * wake word. Everything else is the room talking, and only the note-taker
 * hears it.
 *
 * - "Lead," or "Lead:" — the comma is required, because "Lead the way" and
 *   "lead time is two weeks" are a room talking, and the transcribers this
 *   runs on punctuate a name used to address someone.
 * - "Claude" or "lead agent" — what Bryan says. Both are names rather than
 *   common words, so the comma is optional ("Claude file a task" counts).
 *   Only at the start: "ask Claude later" mid-sentence is the room talking.
 */
export function addressesLead(text: string): boolean {
  return /^\s*(?:lead\s*[,:]|(?:claude|lead[\s-]+agent)\b[\s,:]*)\s*\S/i.test(text);
}

/** How many messages one read hands a page: the first read, and each page
 *  back through the history. */
export const LEAD_CHAT_PAGE = 50;
/** The most a page may ask for in one history read. */
export const LEAD_CHAT_PAGE_MAX = 100;

/**
 * Where a page back through the history starts: the oldest entry the page
 * already shows. Everything strictly before it in `compareLeadChatEntries`
 * order comes next.
 *
 * Keyed on time and id rather than on a position in one log, so a later
 * kind of entry kept somewhere else (the lead's own session, mirrored into
 * the chat) can join the same list and page back in the same order.
 */
export interface LeadChatCursor {
  ts: number;
  id: string;
}

/** `GET /workspaces/<ws>/lead-chat?beforeTs=&beforeId=&limit=`: the
 *  messages just before the cursor, oldest first, and whether there are
 *  older ones still. */
export interface LeadChatHistoryPage {
  messages: LeadChatMessage[];
  more: boolean;
}

/** The one order every list of the chat is kept in: by time, then by id so
 *  two entries written in the same millisecond still sort one way. */
export function compareLeadChatEntries(a: LeadChatCursor, b: LeadChatCursor): number {
  return a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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

/** A stored file's description, or null when it is not one. */
export function parseLeadChatAttachment(raw: unknown): LeadChatAttachment | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { id, name, type, size, image } = raw as Record<string, unknown>;
  const ok = str(id, 100);
  const label = str(name, FILE_NAME_MAX);
  const kind = str(type, FILE_TYPE_MAX);
  if (!ok || !LEAD_CHAT_FILE_ID.test(ok) || !label || !kind) return null;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
  return {
    id: ok,
    name: label,
    type: kind,
    size,
    ...(image === true ? { image: true as const } : {}),
  };
}

function parseAttachments(raw: unknown): LeadChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, LEAD_CHAT_FILES_PER_MESSAGE)
    .map(parseLeadChatAttachment)
    .filter((a): a is LeadChatAttachment => a !== null);
}

const STATES: readonly string[] = ['sent', 'queued', 'received', 'done', 'answered', 'no-lead'];
const VIAS: readonly string[] = ['chat', 'voice', 'terminal', 'channel'];

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

/** A message off the wire or out of the log, or null when it is not one. */
export function parseLeadChatMessage(raw: unknown): LeadChatMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const id = str(m.id, 200);
  const attachments = parseAttachments(m.attachments);
  // Only a message that carries files may have no words.
  const text = attachments.length > 0 && m.text === '' ? '' : str(m.text, LEAD_CHAT_MAX_CHARS * 2);
  const a = m.author as Record<string, unknown> | undefined;
  const authorId = str(a?.id, 200);
  const authorName = str(a?.name, 200);
  if (!id || text === null || !authorId || !authorName) return null;
  if (m.role !== 'person' && m.role !== 'agent') return null;
  if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) return null;
  const state = typeof m.state === 'string' && STATES.includes(m.state) ? m.state : undefined;
  const replyTo = str(m.replyTo, 200);
  const receivedAt =
    typeof m.receivedAt === 'number' && Number.isFinite(m.receivedAt) ? m.receivedAt : undefined;
  const tool = parseToolCall(m.tool);
  return {
    id,
    role: m.role,
    author: { id: authorId, name: authorName },
    text,
    ts: m.ts,
    ...(typeof m.via === 'string' && VIAS.includes(m.via) ? { via: m.via as LeadChatVia } : {}),
    ...(state ? { state: state as LeadChatState } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(m.turnEnd === true ? { turnEnd: true as const } : {}),
    ...(receivedAt !== undefined ? { receivedAt } : {}),
    ...(tool ? { tool } : {}),
    ...(m.streaming === true ? { streaming: true as const } : {}),
    ...(m.written === true ? { written: true as const } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function parseToolCall(raw: unknown): LeadChatToolCall | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const name = str(t.name, 200);
  const input = typeof t.input === 'string' && t.input.length <= LEAD_CHAT_TOOL_INPUT_MAX;
  if (!name || !input) return null;
  const output = str(t.output, LEAD_CHAT_TOOL_OUTPUT_MAX);
  return {
    name,
    input: t.input as string,
    ...(output ? { output } : {}),
    ...(t.failed === true ? { failed: true as const } : {}),
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
  out.sort(compareLeadChatEntries);
  return out;
}
