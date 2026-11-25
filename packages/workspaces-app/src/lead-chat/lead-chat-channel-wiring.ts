/**
 * Which channel the chat shows, and what that changes (M10).
 *
 * Messages and the agent button open one view: the lead chat. Its heading is
 * the channel picker (`lead-chat-channels.ts`). `#general` is the board's
 * chat with its lead, exactly as before; the reader's own lead agent and each
 * other person on the board are one-to-one channels (`dm-client.ts`). A
 * reader with no one-to-one channels sees the chat as it always was, with no
 * picker.
 *
 * The channel shown is kept in the tab's session storage, so the chat reopens
 * where the reader left it, on this page and the next. Each channel keeps its
 * own draft. A message from someone else lands as unread unless the chat is
 * open on its channel; the heading and the board's Messages item show a dot
 * while any channel holds one.
 */
import type { LeadChatLead, LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import type { DmChannelId, DmClient } from './dm-client.ts';
import type { ChannelEntry, ChannelKind } from './lead-chat-channels.ts';
import type { LeadChatState } from './lead-chat-client.ts';
import type { LeadChatView, LeadChatViewModel } from './lead-chat-view.ts';

/** In the tab's session storage: the channel the chat shows. */
export const CHANNEL_KEY = 'cw.lead-chat.channel';

const GENERAL = 'general';

type Session = Pick<Storage, 'getItem' | 'setItem'> | null;

export interface ChannelWiring {
  /** The channel shown: `general`, or a one-to-one channel's id. */
  current(): string;
  /** What the shown channel puts in the view's model in place of the
   *  board chat's. Marks the channel seen while the chat is open on it. */
  model(s: LeadChatState, open: boolean): Partial<LeadChatViewModel>;
  /** Send in the shown one-to-one channel; null in `#general`. */
  send(text: string): Promise<boolean> | null;
  /** Some channel holds a message the reader has not seen. */
  unread(): boolean;
  /** The reader has one-to-one channels. */
  available(): boolean;
  /** Close the channel list if it is open; whether it was. */
  closeMenu(): boolean;
  destroy(): void;
}

export interface ChannelWiringOpts {
  doc: Document;
  view: LeadChatView;
  dm: DmClient;
  session: Session;
  isOpen: () => boolean;
  /** Draw again: the channel, the list or the unread marks changed. */
  changed: () => void;
}

const lineOf = (m: LeadChatMessage | undefined, meId: string | undefined): string | undefined =>
  m ? `${m.author.id === meId ? 'You' : m.author.name}: ${m.text.replace(/\s+/g, ' ')}` : undefined;

/**
 * Who reads `#general`, said on the channel. It is the owner's chat with the
 * lead: the server answers a share visitor's read with a 403 and drops its
 * frames from their stream (`redact-board-events.ts`), so "everyone on this
 * board" was wrong for everyone the board was shared with.
 */
export function generalSub(leadName: string, ownersOnly: boolean): string {
  // Short enough for the heading's one line at 430px: the part that says
  // who is the part a truncation would cut.
  return ownersOnly
    ? `Only the owner and ${leadName} see this`
    : `Only you and ${leadName} see this`;
}

/** What `#general` shows a reader the server refused. */
export const GENERAL_REFUSED =
  'Only the board’s owner can read this chat. Write to them in their own channel instead.';

export function wireChannels(opts: ChannelWiringOpts): ChannelWiring {
  const { doc, view, dm } = opts;
  let current = GENERAL;
  /** The reader chose a channel, on this page or one before it. */
  let chosen = false;
  try {
    const kept = opts.session?.getItem(CHANNEL_KEY) ?? null;
    chosen = kept !== null;
    current = kept ?? GENERAL;
  } catch {
    // Unkept: #general.
  }
  let menuOpen = false;
  const drafts = new Map<string, string>();
  let generalNewest: string | undefined;
  let generalUnread = false;
  let generalSeenOnce = false;

  /** The server refused this reader #general (`LeadChatState.ownersOnly`). */
  let generalRefused = false;
  const has = (id: string): boolean => dm.state().channels.some((c) => c.id === id);
  /** The channel shown, once the list says it still exists. A reader refused
   *  #general opens on a conversation they can use, a person's first. */
  const shown = (): string => {
    if (current !== GENERAL && has(current)) return current;
    if (generalRefused) {
      const channels = dm.state().channels;
      const open = channels.find((c) => c.kind === 'person') ?? channels[0];
      if (open && !chosen) return open.id;
    }
    return GENERAL;
  };

  dm.watching((id) => opts.isOpen() && shown() === id);

  const pick = (id: string): void => {
    drafts.set(shown(), view.composer.value);
    current = id;
    chosen = true;
    menuOpen = false;
    try {
      opts.session?.setItem(CHANNEL_KEY, id);
    } catch {
      // Unkept, the next page opens on #general.
    }
    view.composer.value = drafts.get(id) ?? '';
    view.send.disabled = view.composer.value.trim() === '';
    if (id !== GENERAL) void dm.show(id as DmChannelId);
    opts.changed();
    view.picker.button.focus();
  };

  view.picker.button.addEventListener('click', () => {
    menuOpen = !menuOpen;
    opts.changed();
    if (menuOpen) view.picker.menu.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  });
  view.picker.menu.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest?.('[data-chan]') as HTMLElement | null;
    if (b?.dataset.chan) pick(b.dataset.chan);
  });
  const onDocClick = (e: Event): void => {
    if (!menuOpen) return;
    const path = e.composedPath();
    if (path.includes(view.picker.menu) || path.includes(view.picker.button)) return;
    menuOpen = false;
    opts.changed();
  };
  doc.addEventListener('click', onDocClick, true);
  // A channel the tab reopened on is read as soon as the list knows it.
  dm.onChange(() => {
    const id = shown();
    if (id !== GENERAL && !dm.state().loaded.has(id as DmChannelId))
      void dm.show(id as DmChannelId);
    opts.changed();
  });

  /** #general's unread: the lead said something newer than the last line
   *  drawn while the chat was not open on it. The first read marks nothing,
   *  and nor does a tool call. */
  const trackGeneral = (s: LeadChatState, open: boolean): void => {
    if (!s.loaded) return;
    const newest = s.messages.at(-1);
    if (generalSeenOnce && newest?.id !== generalNewest) {
      if (newest?.role === 'agent' && !newest.tool) generalUnread = true;
    }
    generalNewest = newest?.id;
    generalSeenOnce = true;
    if (open && (shown() === GENERAL || !!s.meeting)) generalUnread = false;
  };

  const entries = (s: LeadChatState, open: boolean): ChannelEntry[] => {
    const d = dm.state();
    const meId = d.me?.id;
    const newest = s.messages.at(-1);
    const leadName = s.lead?.name ?? 'the lead';
    const out: ChannelEntry[] = [
      {
        id: GENERAL,
        kind: 'general',
        name: '#general',
        sub: generalSub(leadName, s.ownersOnly === true),
        ...(lineOf(newest, meId) ? { last: lineOf(newest, meId) } : {}),
        unread: generalUnread,
      },
    ];
    for (const c of d.channels) {
      if (open && shown() === c.id) dm.seen(c.id);
      const last = lineOf(d.messages.get(c.id)?.at(-1), meId);
      out.push({
        id: c.id,
        kind: c.kind as ChannelKind,
        name: c.name,
        sub: c.kind === 'lead' ? 'Your lead agent · only you two' : 'Only you two',
        ...(last ? { last } : {}),
        unread: d.unread.has(c.id),
      });
    }
    return out;
  };

  return {
    current: shown,
    model(s, open) {
      generalRefused = s.ownersOnly === true;
      trackGeneral(s, open);
      const showing = shown();
      if (showing !== GENERAL && !dm.state().loaded.has(showing as DmChannelId))
        void dm.show(showing as DmChannelId);
      // Refused and nothing else to pick: the one channel still says whose it is.
      if (s.ownersOnly && !s.meeting && !(dm.state().ready && dm.state().channels.length > 0)) {
        const sub = generalSub(s.lead?.name ?? 'the lead', true);
        const general: ChannelEntry = {
          id: GENERAL,
          kind: 'general',
          name: '#general',
          sub,
          unread: false,
        };
        const picker = { channels: [general], current: GENERAL, menuOpen: false };
        return { channel: { kind: 'general', sub, empty: GENERAL_REFUSED, picker } };
      }
      if (!dm.state().ready || dm.state().channels.length === 0 || s.meeting) return {};
      const list = entries(s, open);
      const id = shown();
      const entry = list.find((c) => c.id === id) ?? list[0];
      if (!entry) return {};
      const picker = { channels: list, current: entry.id, menuOpen };
      if (entry.kind === 'general') {
        return {
          channel: {
            kind: 'general',
            sub: entry.sub,
            ...(s.ownersOnly ? { empty: GENERAL_REFUSED } : {}),
            picker,
          },
        };
      }
      const d = dm.state();
      const ch = d.channels.find((c) => c.id === id);
      const lead: LeadChatLead = { agentId: ch?.peerId ?? id, name: entry.name };
      return {
        lead,
        messages: d.messages.get(id as DmChannelId) ?? [],
        loaded: d.loaded.has(id as DmChannelId),
        canTalk: true,
        more: false,
        loadingOlder: false,
        channel: {
          kind: entry.kind,
          sub: entry.sub,
          empty:
            entry.kind === 'lead'
              ? `Ask ${entry.name} anything. Only you two see this conversation.`
              : `Only you and ${entry.name} see this conversation.`,
          picker,
        },
      };
    },
    send(text) {
      const id = shown();
      return id === GENERAL ? null : dm.send(id as DmChannelId, text);
    },
    unread() {
      return generalUnread || dm.state().unread.size > 0;
    },
    available() {
      return dm.state().ready && dm.state().channels.length > 0;
    },
    closeMenu() {
      if (!menuOpen) return false;
      menuOpen = false;
      opts.changed();
      view.picker.button.focus();
      return true;
    },
    destroy() {
      doc.removeEventListener('click', onDocClick, true);
      dm.close();
    },
  };
}
