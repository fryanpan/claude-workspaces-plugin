/**
 * The chat's one-to-one channels (M10): the reader's own lead agent and each
 * other person on the board. `#general`, the board's chat with its lead, is
 * `lead-chat-client.ts`; this is everything the picker lists below it.
 *
 * The list and each conversation are read from the server
 * (`GET /workspaces/<id>/me/dm`, `GET /api/me/messages`), and every change
 * after that arrives on the reader's own stream
 * (`/workspaces/<id>/me/events:stream`), which only their own sign-in opens:
 * a direct message on `direct.message`, a message with their lead agent on
 * `private.message`. A stream that dropped may have missed some, so every
 * conversation already read is read again when it comes back.
 *
 * A reader the server does not know as a signed-in person on this board gets
 * no channels here, and the chat shows `#general` alone.
 *
 * Messages are handed out in the lead chat's own shape, so its list draws
 * them: the reader's own as `person`, the other side's as `agent`.
 */
import {
  DIRECT_MESSAGE_EVENT,
  type DirectChannels,
  type DirectMessage,
  PRIVATE_MESSAGE_EVENT,
} from '@claude-workspaces/core/direct-messages';
import { type LeadChatMessage, upsertLeadChatMessage } from '@claude-workspaces/core/lead-chat';

/** `lead` is the reader's own lead agent; a person's channel is `p:<id>`. */
export type DmChannelId = 'lead' | `p:${string}`;

export interface DmChannel {
  id: DmChannelId;
  kind: 'lead' | 'person';
  /** Their id: the agent's, or the person's. */
  peerId: string;
  name: string;
}

export interface DmState {
  /** False until the list answers; still false for a reader with none. */
  ready: boolean;
  me: { id: string; name: string } | null;
  channels: DmChannel[];
  /** Each conversation read so far, oldest first. */
  messages: ReadonlyMap<DmChannelId, readonly LeadChatMessage[]>;
  loaded: ReadonlySet<DmChannelId>;
  /** Channels with a message from the other side the reader has not seen. */
  unread: ReadonlySet<DmChannelId>;
}

export interface DmClient {
  state(): DmState;
  onChange(fn: (s: DmState) => void): void;
  /** Read a channel's conversation, once; later changes arrive live. */
  show(id: DmChannelId): Promise<void>;
  send(id: DmChannelId, text: string): Promise<boolean>;
  /** The reader is looking at this channel: it is no longer unread. Quiet,
   *  so a render can call it; the caller is already drawing. */
  seen(id: DmChannelId): void;
  /** Whether a message arriving now on `id` is seen as it lands. */
  watching(fn: (id: DmChannelId) => boolean): void;
  close(): void;
}

export interface DmClientOpts {
  workspaceId: string;
  fetch?: typeof fetch;
  openStream?: (url: string) => EventSource;
}

type PrivateFrame = {
  messageId: string;
  from: 'person' | 'agent';
  author: { id: string; name: string };
  text: string;
  ts: number;
};

export const personChannel = (personId: string): DmChannelId => `p:${personId}`;

export function createDmClient(opts: DmClientOpts): DmClient {
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const base = `/workspaces/${encodeURIComponent(opts.workspaceId)}`;
  let me: DmState['me'] = null;
  let channels: DmChannel[] = [];
  let ready = false;
  const messages = new Map<DmChannelId, LeadChatMessage[]>();
  const loaded = new Set<DmChannelId>();
  const unread = new Set<DmChannelId>();
  const listeners: Array<(s: DmState) => void> = [];
  let watching: (id: DmChannelId) => boolean = () => false;
  let stream: EventSource | null = null;
  let closed = false;

  const state = (): DmState => ({ ready, me, channels, messages, loaded, unread });
  const changed = (): void => {
    for (const fn of listeners) fn(state());
  };
  const mine = (authorId: string): boolean => authorId === me?.id;

  const ofDirect = (m: DirectMessage): LeadChatMessage => ({
    id: m.id,
    role: mine(m.author.id) ? 'person' : 'agent',
    author: m.author,
    text: m.text,
    ts: m.ts,
  });
  const ofPrivate = (m: PrivateFrame): LeadChatMessage => ({
    id: m.messageId,
    role: m.from,
    author: m.author,
    text: m.text,
    ts: m.ts,
  });

  /** A stored private message, as the read and the send answer with it. */
  const ofStored = (raw: unknown): LeadChatMessage => {
    const m = raw as Omit<PrivateFrame, 'messageId'> & { id: string };
    return ofPrivate({ ...m, messageId: m.id });
  };

  const put = (id: DmChannelId, m: LeadChatMessage, live: boolean): void => {
    messages.set(id, upsertLeadChatMessage(messages.get(id) ?? [], m));
    if (live && m.role === 'agent' && !watching(id)) unread.add(id);
  };

  const read = async (id: DmChannelId): Promise<void> => {
    const ch = channels.find((c) => c.id === id);
    if (!ch) return;
    const url =
      ch.kind === 'lead'
        ? '/api/me/messages'
        : `${base}/me/dm?with=${encodeURIComponent(ch.peerId)}`;
    try {
      const res = await doFetch(url, { credentials: 'same-origin' });
      if (!res.ok) return;
      const body = (await res.json()) as { messages?: unknown[] };
      for (const raw of body.messages ?? []) {
        put(id, ch.kind === 'lead' ? ofStored(raw) : ofDirect(raw as DirectMessage), false);
      }
      loaded.add(id);
      changed();
    } catch {
      // Offline: the stream's return reads it again.
    }
  };

  const listen = (): void => {
    const url = `${base}/me/events:stream`;
    stream = opts.openStream ? opts.openStream(url) : new EventSource(url);
    let dropped = false;
    stream.addEventListener('error', () => {
      dropped = true;
    });
    stream.addEventListener('open', () => {
      if (!dropped) return;
      dropped = false;
      for (const id of loaded) void read(id);
    });
    stream.addEventListener(DIRECT_MESSAGE_EVENT, (ev) => {
      try {
        const frame = JSON.parse((ev as MessageEvent).data) as {
          workspaceId?: string;
          message?: DirectMessage;
        };
        const m = frame.message;
        if (!m || frame.workspaceId !== opts.workspaceId) return;
        const peer = mine(m.author.id) ? m.to : m.author.id;
        put(personChannel(peer), ofDirect(m), true);
        changed();
      } catch {
        // A frame this page cannot read changes nothing.
      }
    });
    stream.addEventListener(PRIVATE_MESSAGE_EVENT, (ev) => {
      try {
        const frame = JSON.parse((ev as MessageEvent).data) as PrivateFrame;
        if (!channels.some((c) => c.id === 'lead')) return;
        put('lead', ofPrivate(frame), true);
        changed();
      } catch {
        // As above.
      }
    });
  };

  const start = async (): Promise<void> => {
    try {
      const res = await doFetch(`${base}/me/dm`, { credentials: 'same-origin' });
      if (!res.ok || closed) return;
      const list = (await res.json()) as DirectChannels;
      me = list.me;
      channels = [
        ...(list.lead
          ? [
              {
                id: 'lead' as const,
                kind: 'lead' as const,
                peerId: list.lead.agentId,
                name: list.lead.name,
              },
            ]
          : []),
        ...list.people.map((p) => ({
          id: personChannel(p.id),
          kind: 'person' as const,
          peerId: p.id,
          name: p.name,
        })),
      ];
      ready = true;
      listen();
      changed();
    } catch {
      // No channels: the chat is #general alone.
    }
  };
  void start();

  return {
    state,
    onChange(fn) {
      listeners.push(fn);
    },
    async show(id) {
      if (!loaded.has(id)) await read(id);
    },
    async send(id, text) {
      const ch = channels.find((c) => c.id === id);
      if (!ch) return false;
      const lead = ch.kind === 'lead';
      try {
        const res = await doFetch(lead ? '/api/me/messages' : `${base}/me/dm`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(lead ? { text } : { to: ch.peerId, text }),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { message: unknown };
        put(id, lead ? ofStored(body.message) : ofDirect(body.message as DirectMessage), false);
        changed();
        return true;
      } catch {
        return false;
      }
    },
    seen(id) {
      unread.delete(id);
    },
    watching(fn) {
      watching = fn;
    },
    close() {
      closed = true;
      stream?.close();
    },
  };
}
