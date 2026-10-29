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
  type LeadChatFrame,
  type LeadChatMessage,
  type LeadChatRead,
  upsertLeadChatMessage,
} from '@claude-workspaces/core/lead-chat';
import type { VoiceContext } from '../voice-capture.ts';

export interface LeadChatClientOpts {
  workspaceId: string;
  /** Injected by tests. */
  fetch?: typeof fetch;
  openStream?: (url: string) => EventSource;
}

export interface LeadChatState extends LeadChatRead {
  /** False until the first read answers. */
  loaded: boolean;
}

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
  close(): void;
}

export function createLeadChatClient(opts: LeadChatClientOpts): LeadChatClient {
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const base = `/workspaces/${encodeURIComponent(opts.workspaceId)}`;
  let state: LeadChatState = { lead: null, messages: [], canTalk: false, loaded: false };
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
      state = { ...read, messages, loaded: true };
      changed();
    } catch {
      // Offline: the next reconnect reads again.
    }
  };

  const stream = (opts.openStream ?? ((u) => new EventSource(u)))(`${base}/events:stream`);
  let dropped = false;
  stream.addEventListener(LEAD_CHAT_EVENT, (ev) => {
    try {
      const frame = JSON.parse((ev as MessageEvent).data) as LeadChatFrame;
      if (frame.workspaceId === opts.workspaceId && frame.message) apply(frame.message);
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
    close: () => stream.close(),
  };
}
