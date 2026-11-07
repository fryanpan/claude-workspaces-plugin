/**
 * The page's half of the lead chat: read the board's conversation, send a
 * message, and hear every change on the board's own stream.
 *
 * The stream frame carries the whole message, so a change is applied in
 * place with no read. A stream that dropped and came back may have missed
 * frames, so a reconnect reads the conversation again — the frames are
 * transient (`lead-chat/lead-chat.ts` on the server) and a gap is never
 * replayed.
 *
 * The first read holds the latest page; `loadOlder` pages back from the
 * oldest message shown until the server says there is nothing before it.
 */
import {
  LEAD_CHAT_EVENT,
  LEAD_CHAT_MEETING_EVENT,
  LEAD_CHAT_MEETING_LINE_EVENT,
  LEAD_CHAT_MODEL_EVENT,
  type LeadChatAttachment,
  type LeadChatFrame,
  type LeadChatHistoryPage,
  type LeadChatMeeting,
  type LeadChatMeetingFrame,
  type LeadChatMeetingLine,
  type LeadChatMeetingLineFrame,
  type LeadChatMessage,
  type LeadChatModelFrame,
  type LeadChatRead,
  type LeadEffort,
  type LeadModelAlias,
  type LeadModelState,
  compareLeadChatEntries,
  upsertLeadChatMessage,
  upsertMeetingLine,
} from '@claude-workspaces/core/lead-chat';
import { boardStreamUrl, openBoardStream } from '../board-stream.ts';
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
  /** Messages older than the first one held exist on the server. */
  more: boolean;
  /** A page back is on its way. */
  loadingOlder: boolean;
}

export type MeetingAnswer =
  | { ok: true; meeting?: LeadChatMeeting; message?: string; lead?: 'sign-in' }
  | { ok: false; error: string };

export type UploadResult = { ok: true; file: LeadChatAttachment } | { ok: false; error: string };
export type ModelPickResult = { ok: true } | { ok: false; error: string };

export type SendResult = { ok: true; message: LeadChatMessage } | { ok: false; error: string };

export interface LeadChatClient {
  state(): LeadChatState;
  /** Called after every change, with the state as it now stands. */
  onChange(fn: (s: LeadChatState) => void): void;
  /** Called when the lead says a line into the meeting, as it arrives. */
  onLeadLine(fn: (meetingId: string, line: LeadChatMeetingLine) => void): void;
  send(
    text: string,
    author: { id: string; name: string; kind?: string },
    context: VoiceContext | undefined,
    via: 'chat' | 'voice',
    attachments?: readonly string[],
  ): Promise<SendResult>;
  /** Store a file under the board, ready for a send to carry its id. */
  uploadFile(file: File): Promise<UploadResult>;
  /** Switch the lead's model or effort (`lead-chat/lead-model.ts`). */
  pickModel(pick: { model?: LeadModelAlias; effort?: LeadEffort }): Promise<ModelPickResult>;
  /** One verb on the board's meeting (`start`, `recording`, `line`, `join`,
   *  `end`); a meeting it answers with is applied before this resolves. */
  /** Read the page of messages before the oldest one held, when there is
   *  one and no read for it is already out. After a read that failed, only
   *  a call with `retry` asks again — a scroll, never a redraw. */
  loadOlder(opts?: { retry?: boolean }): Promise<void>;
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
    more: false,
    loadingOlder: false,
  };
  const listeners: Array<(s: LeadChatState) => void> = [];
  const leadLines: Array<(meetingId: string, line: LeadChatMeetingLine) => void> = [];
  const changed = (): void => {
    for (const fn of listeners) fn(state);
  };
  const apply = (m: LeadChatMessage): void => {
    state = { ...state, messages: upsertLeadChatMessage(state.messages, m) };
    changed();
  };

  const setLeadModel = (leadModel: LeadModelState): void => {
    state = { ...state, leadModel };
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
      // Pages already read back stay, and so does what the oldest of them
      // said about anything before it.
      const first = read.messages[0];
      const held = messages[0];
      const keepsOlder = !!first && !!held && compareLeadChatEntries(held, first) < 0;
      state = {
        ...read,
        messages,
        meeting: read.meeting ?? null,
        loaded: true,
        more: keepsOlder ? state.more : read.more === true,
        loadingOlder: state.loadingOlder,
      };
      changed();
    } catch {
      // Offline: the next reconnect reads again.
    }
  };

  // The page's one board stream, shared with the tab title (`board-stream.ts`).
  const stream =
    opts.stream ??
    (opts.openStream
      ? opts.openStream(boardStreamUrl(opts.workspaceId))
      : openBoardStream(opts.workspaceId));
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
      if (frame.line.lead) for (const fn of leadLines) fn(m.id, frame.line);
    } catch {
      // A frame this page cannot read changes nothing.
    }
  });
  stream.addEventListener(LEAD_CHAT_MODEL_EVENT, (ev) => {
    try {
      const frame = JSON.parse((ev as MessageEvent).data) as LeadChatModelFrame;
      if (frame.workspaceId !== opts.workspaceId) return;
      setLeadModel(frame.state);
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

  let olderFailed = false;
  const loadOlder = async (opts: { retry?: boolean } = {}): Promise<void> => {
    const oldest = state.messages[0];
    if (!state.more || state.loadingOlder || !oldest) return;
    if (olderFailed && !opts.retry) return;
    state = { ...state, loadingOlder: true };
    changed();
    let page: LeadChatHistoryPage | null = null;
    try {
      const q = `beforeTs=${oldest.ts}&beforeId=${encodeURIComponent(oldest.id)}`;
      const res = await doFetch(`${base}/lead-chat?${q}`, { credentials: 'same-origin' });
      if (res.ok) page = (await res.json()) as LeadChatHistoryPage;
    } catch {
      // Offline: the next scroll to the top asks again.
    }
    olderFailed = page === null;
    let messages = state.messages;
    for (const m of page?.messages ?? []) {
      // A copy already held came by frame, and is the newer one.
      if (!messages.some((x) => x.id === m.id)) messages = upsertLeadChatMessage(messages, m);
    }
    state = {
      ...state,
      messages,
      more: page ? page.more : state.more,
      loadingOlder: false,
    };
    changed();
  };

  return {
    state: () => state,
    onChange: (fn) => {
      listeners.push(fn);
    },
    onLeadLine: (fn) => {
      leadLines.push(fn);
    },
    loadOlder,
    async uploadFile(file) {
      try {
        const q = `name=${encodeURIComponent(file.name || 'Pasted image')}`;
        const res = await doFetch(`${base}/lead-chat/files?${q}`, {
          method: 'POST',
          credentials: 'same-origin',
          body: file,
        });
        const body = (await res.json().catch(() => ({}))) as {
          file?: LeadChatAttachment;
          error?: string;
        };
        if (!res.ok || !body.file) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
        return { ok: true, file: body.file };
      } catch {
        return { ok: false, error: 'offline' };
      }
    },
    async pickModel(pick) {
      try {
        const res = await doFetch(`${base}/lead-chat/model`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(pick),
        });
        const body = (await res.json().catch(() => ({}))) as {
          state?: LeadModelState;
          error?: string;
        };
        if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
        if (body.state) setLeadModel(body.state);
        return { ok: true };
      } catch {
        return { ok: false, error: 'offline' };
      }
    },
    async send(text, author, context, via, attachments) {
      try {
        const res = await doFetch(`${base}/lead-chat`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            author,
            via,
            ...(context ? { context } : {}),
            ...(attachments?.length ? { attachments } : {}),
          }),
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
