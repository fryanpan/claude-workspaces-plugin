/**
 * The page's half of the lead chat: read the board's conversation, send a
 * message, and hear every change on the board's own stream.
 *
 * The stream frame carries the whole message, so a change is applied in
 * place with no read. A stream that dropped and came back may have missed
 * frames, so a reconnect reads the conversation again — the frames are
 * transient (`lead-chat/lead-chat.ts` on the server) and a gap is never
 * replayed.
 */
import {
  LEAD_CHAT_EVENT,
  LEAD_CHAT_MEETING_EVENT,
  LEAD_CHAT_MEETING_LINE_EVENT,
  type LeadChatFrame,
  type LeadChatMeeting,
  type LeadChatMeetingFrame,
  type LeadChatMeetingLineFrame,
  type LeadChatMessage,
  type LeadChatRead,
  upsertLeadChatMessage,
  upsertMeetingLine,
} from '@claude-workspaces/core/lead-chat';
import type { VoiceContext } from '../voice-capture.ts';

export interface LeadChatClientOpts {
  workspaceId: string;
  /** Injected by tests. */
  fetch?: typeof fetch;
  openStream?: (url: string) => EventSource;
  /** The page's own board feed, shared rather than a second connection to
   *  the same URL; it stays open when this client closes. */
  stream?: EventSource;
}

export interface LeadChatState extends LeadChatRead {
  /** False until the first read answers. */
  loaded: boolean;
  /** The board's meeting, live on every page (`lead-chat/meeting.ts` on the
   *  server), or null. */
  meeting: LeadChatMeeting | null;
}

export type MeetingAnswer =
  | { ok: true; meeting?: LeadChatMeeting; message?: string; lead?: 'sign-in' }
  | { ok: false; error: string };

export type SendResult = { ok: true; message: LeadChatMessage } | { ok: false; error: string };

export interface LeadChatClient {
  state(): LeadChatState;
  /** Called after every change, with the state as it now stands. */
  onChange(fn: (s: LeadChatState) => void): void;
  send(
    text: string,
    author: { id: string; name: string; kind?: string },
    context: VoiceContext | undefined,
    via: 'chat' | 'voice',
  ): Promise<SendResult>;
  /** One verb on the board's meeting (`start`, `recording`, `line`, `join`,
   *  `end`); a meeting it answers with is applied before this resolves. */
  meeting(
    action: string,
    author: { id: string; name: string; kind?: string },
    body: Record<string, unknown>,
  ): Promise<MeetingAnswer>;
  close(): void;
}

export function createLeadChatClient(opts: LeadChatClientOpts): LeadChatClient {
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const base = `/workspaces/${encodeURIComponent(opts.workspaceId)}`;
  let state: LeadChatState = {
    lead: null,
    messages: [],
    canTalk: false,
    loaded: false,
    meeting: null,
  };
  const listeners: Array<(s: LeadChatState) => void> = [];
  const changed = (): void => {
    for (const fn of listeners) fn(state);
  };
  const apply = (m: LeadChatMessage): void => {
    state = { ...state, messages: upsertLeadChatMessage(state.messages, m) };
    changed();
  };

  const load = async (): Promise<void> => {
    try {
      const res = await doFetch(`${base}/lead-chat`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const read = (await res.json()) as LeadChatRead;
      // A message a frame brought while the read was in flight, and the read
      // does not hold yet, is kept; the read's copy wins for the rest.
      let messages = read.messages;
      for (const m of state.messages) {
        if (!messages.some((x) => x.id === m.id)) messages = upsertLeadChatMessage(messages, m);
      }
      state = { ...read, messages, meeting: read.meeting ?? null, loaded: true };
      changed();
    } catch {
      // Offline: the next reconnect reads again.
    }
  };

  const stream =
    opts.stream ?? (opts.openStream ?? ((u) => new EventSource(u)))(`${base}/events:stream`);
  let dropped = false;
  stream.addEventListener(LEAD_CHAT_EVENT, (ev) => {
    try {
      const frame = JSON.parse((ev as MessageEvent).data) as LeadChatFrame;
      if (frame.workspaceId === opts.workspaceId && frame.message) apply(frame.message);
    } catch {
      // A frame this page cannot read changes nothing.
    }
  });
  stream.addEventListener(LEAD_CHAT_MEETING_EVENT, (ev) => {
    try {
      const frame = JSON.parse((ev as MessageEvent).data) as LeadChatMeetingFrame;
      if (frame.workspaceId !== opts.workspaceId) return;
      state = { ...state, meeting: frame.meeting };
      changed();
    } catch {
      // A frame this page cannot read changes nothing.
    }
  });
  stream.addEventListener(LEAD_CHAT_MEETING_LINE_EVENT, (ev) => {
    try {
      const frame = JSON.parse((ev as MessageEvent).data) as LeadChatMeetingLineFrame;
      const m = state.meeting;
      if (frame.workspaceId !== opts.workspaceId || !m || m.id !== frame.meeting) return;
      state = { ...state, meeting: { ...m, lines: upsertMeetingLine(m.lines, frame.line) } };
      changed();
    } catch {
      // A frame this page cannot read changes nothing.
    }
  });
  stream.addEventListener('error', () => {
    dropped = true;
  });
  stream.addEventListener('open', () => {
    if (!dropped) return;
    dropped = false;
    void load();
  });
  void load();

  return {
    state: () => state,
    onChange: (fn) => {
      listeners.push(fn);
    },
    async send(text, author, context, via) {
      try {
        const res = await doFetch(`${base}/lead-chat`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, author, via, ...(context ? { context } : {}) }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          message?: LeadChatMessage;
          error?: string;
        };
        if (!res.ok || !body.message)
          return { ok: false, error: body.error ?? `HTTP ${res.status}` };
        apply(body.message);
        return { ok: true, message: body.message };
      } catch {
        return { ok: false, error: 'offline' };
      }
    },
    async meeting(action, author, body) {
      try {
        const res = await doFetch(`${base}/lead-chat/meeting`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, action, author }),
        });
        const got = (await res.json().catch(() => ({}))) as {
          meeting?: LeadChatMeeting;
          message?: string;
          lead?: string;
          error?: string;
        };
        if (!res.ok) return { ok: false, error: got.error ?? `HTTP ${res.status}` };
        if (action === 'end') state = { ...state, meeting: null };
        else if (got.meeting) state = { ...state, meeting: got.meeting };
        if (action === 'end' || got.meeting) changed();
        return {
          ok: true,
          ...(got.meeting ? { meeting: got.meeting } : {}),
          ...(got.message ? { message: got.message } : {}),
          ...(got.lead === 'sign-in' ? { lead: 'sign-in' as const } : {}),
        };
      } catch {
        return { ok: false, error: 'offline' };
      }
    },
    close: () => {
      if (!opts.stream) stream.close();
    },
  };
}
