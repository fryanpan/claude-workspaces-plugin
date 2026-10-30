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
