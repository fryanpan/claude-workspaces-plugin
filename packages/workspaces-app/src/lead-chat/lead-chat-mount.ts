/**
 * The lead chat on a page: the agent button, its bar and its panel, wired to
 * the board's conversation with its lead (`lead-chat-client.ts`).
 *
 * The agent button is the chat's one listen control (Bryan, 2026-10-31).
 * What its first tap does is this device's choice (`lead-chat-mode.ts`),
 * read at the tap:
 *   - Chat first: the panel opens with the cursor in its composer, and the
 *     page starts listening.
 *   - Voice first: the bar comes out and the page starts listening; every
 *     line heard goes to the lead as it ends.
 * With the panel open, each tap stops or starts listening, and only the
 * panel's Close closes it. With only the bar out, a tap puts it away and
 * stops listening. A tap on the bar grows it into the panel. In a meeting
 * the room's voice is the meeting's, so the button only opens and closes.
 *
 * Listening is the board mic's own path (`lead-chat-voice.ts`): the
 * microphone streams to this server over the converse socket, which hears it
 * and hands each question to the lead alone. The server writes the spoken
 * turn and the lead's answer into the chat, so they arrive on the same stream
 * as a typed message, and the answer is also said aloud.
 *
 * Voice on survives a move to another of the board's pages (Bryan,
 * 2026-11-03). A link to a doc, a mock or the board from another page is a
 * full load, and only the tab's session storage crosses it: the panel's open
 * flag, and `VOICE_ON_KEY` while the page is listening. The next page opens
 * the same bar or panel and starts listening again without a tap where the
 * browser allows it (`start({ gesture: false })`), and asks for one tap
 * where it does not (iOS Safari). On a phone the side nav's pages move the
 * full-screen panel out of the way into the bar rather than closing the chat.
 *
 * The button is drawn only for a reader who may talk to the lead — the
 * board's owner — so nobody else is offered a composer that refuses.
 */
import type { VoiceContext } from '../voice-capture.ts';
import { type LeadChatClient, createLeadChatClient } from './lead-chat-client.ts';
import { messageLinkOf, withMessageLink } from './lead-chat-link.ts';
import {
  type LeadMeetingSeams,
  PANE_OPEN_KEY,
  wireLeadMeeting,
} from './lead-chat-meeting-wiring.ts';
import { type ModeStorage, deviceStorage, readLeadChatMode } from './lead-chat-mode.ts';
import { LEAVE_EVENT, type LeadChatView, createLeadChatView } from './lead-chat-view.ts';
import {
  type LeadVoice,
  type LeadVoiceOpts,
  type LeadVoiceState,
  createLeadVoice,
} from './lead-chat-voice.ts';

/** In the tab's session storage while the page is listening, so the next
 *  page listens again. */
export const VOICE_ON_KEY = 'cw.lead-chat.voice';

export interface LeadChatMountOpts {
  workspaceId: string;
  author: { id: string; name: string; kind?: string };
  /** Where the reader is, read at each send. The page's link is added to it
   *  here, from the address (`lead-chat-link.ts`). */
  getContext?: () => VoiceContext | undefined;
  /** The thread a doc page has open, which its address does not follow. */
  openThread?: () => string | null;
  /** A slot in the board's dock; omitted, the button floats bottom-left. */
  dock?: HTMLElement;
  document?: Document;
  /** The page's open board feed, shared by the chat's client. */
  stream?: EventSource;
  /** Injected by tests. */
  client?: LeadChatClient;
  storage?: ModeStorage | null;
  /** Per tab: which tab records the board's meeting. Defaults to the
   *  page's session storage. */
  session?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** The meeting's seams; tests pass fakes for the socket, the mic and the
   *  board's docs. */
  meeting?: LeadMeetingSeams;
  /** The voice path's seams; tests pass fakes for the socket and the mic. */
  voice?: Partial<
    Omit<LeadVoiceOpts, 'workspaceId' | 'author' | 'getContext' | 'agent' | 'onChange'>
  >;
  reducedMotion?: () => boolean;
}

export interface LeadChatMount {
  view: LeadChatView;
  /** Open the pane on the Start a meeting wizard — the board's "Have a
   *  meeting". With a meeting already running, only the pane opens. */
  startMeeting(): void;
  destroy(): void;
}

const GROW_MS = 200;

function tabStorage(win: Window): Storage | null {
  try {
    return win.sessionStorage;
  } catch {
    return null;
  }
}

export function mountLeadChat(opts: LeadChatMountOpts): LeadChatMount {
  const doc = opts.document ?? document;
  const win = doc.defaultView ?? window;
  const host = opts.dock ?? doc.createElement('span');
  host.dataset.leadChat = 'button';
  if (!opts.dock) doc.body.append(host);
  host.hidden = true;
  const storage = opts.storage === undefined ? deviceStorage() : opts.storage;
  const session = opts.session === undefined ? tabStorage(win) : opts.session;
  const view = createLeadChatView({
    document: doc,
    buttonHost: host,
    placement: opts.dock ? 'dock' : 'float',
    storage,
  });
  // A floated button sits under the coach's card; this keeps the card above it.
  if (!opts.dock) doc.documentElement.style.setProperty('--lc-agent-room', '56px');
  const client =
    opts.client ??
    createLeadChatClient({
      workspaceId: opts.workspaceId,
      ...(opts.stream ? { stream: opts.stream } : {}),
    });
  const reduced =
    opts.reducedMotion ?? (() => win.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  const ui = { open: false, bar: false, notice: '' };
  /** The panel stays open as the reader moves between the board's pages:
   *  this tab remembers it was open, and the next page opens it again. */
  const keepOpen = (open: boolean): void => {
    try {
      if (open) session?.setItem(PANE_OPEN_KEY, '1');
      else session?.removeItem(PANE_OPEN_KEY);
    } catch {
      // Unkept, the next page opens closed.
    }
  };
  /** The same for listening. Not touched while the page unloads: its
   *  socket closing then is the move, not the reader turning voice off. */
  const keepVoice = (on: boolean): void => {
    if (hiding) return;
    try {
      if (on) session?.setItem(VOICE_ON_KEY, '1');
      else session?.removeItem(VOICE_ON_KEY);
    } catch {
      // Unkept, the next page starts with voice off.
    }
  };
  let hiding = false;
  let restored = false;
  let heard: LeadVoiceState = { phase: 'off', heard: '', notice: '' };
  /** Voice was on on the page before: start it once the lead is known. */
  const carryVoice = (s: ReturnType<LeadChatClient['state']>): void => {
    let kept = false;
    try {
      kept = session?.getItem(VOICE_ON_KEY) === '1';
    } catch {
      // Nothing kept.
    }
    if (!kept) return;
    if (!s.canTalk || s.meeting) {
      keepVoice(false);
      return;
    }
    if (!ui.open) ui.bar = true;
    queueMicrotask(() => voice.start({ gesture: false }));
  };

  const render = (): void => {
    const s = client.state();
    if (!restored && s.loaded) {
      restored = true;
      try {
        if (s.canTalk && session?.getItem(PANE_OPEN_KEY) === '1') ui.open = true;
      } catch {
        // Nothing kept.
      }
      carryVoice(s);
    }
    host.hidden = !(s.loaded && s.canTalk);
    view.render({
      lead: s.lead,
      messages: s.messages,
      canTalk: s.canTalk,
      loaded: s.loaded,
      meId: opts.author.id,
      open: ui.open,
      barOut: ui.bar,
      listening: heard.phase !== 'off',
      ...(heard.phase !== 'off' ? { voice: heard.phase } : {}),
      heard: heard.heard,
      notice: ui.notice || heard.notice,
      ...(meet ? { meeting: meet.model() } : {}),
      more: s.more,
      loadingOlder: s.loadingOlder,
    });
    view.button.dataset.meeting = String(!!s.meeting);
    olderIfAtTop();
  };
  /** Scrolled to the top of the open list, or a first page too short to
   *  scroll: read the page before, until the first message. */
  const olderIfAtTop = (retry = false): void => {
    const s = client.state();
    if (ui.open && s.more && !s.loadingOlder && view.nearTop()) void client.loadOlder({ retry });
  };
  // Assigned below; the first renders run before the meeting is wired.
  let meet: ReturnType<typeof wireLeadMeeting> | null = null;
  client.onChange(() => {
    meet?.sync();
    render();
  });

  /** Where the reader is, with the link to what they have open, and
   *  whether they can read the chat as well as hear the answer. */
  const context = (): VoiceContext | undefined => {
    const at = withMessageLink(
      opts.getContext?.(),
      messageLinkOf(win.location.pathname, win.location.search, opts.openThread?.()),
    );
    return at ? { ...at, chatOpen: ui.open } : undefined;
  };

  const deliver = async (text: string, via: 'chat' | 'voice'): Promise<boolean> => {
    const res = await client.send(text, opts.author, context(), via);
    ui.notice = res.ok ? '' : 'Not sent. Check the connection and try again.';
    render();
    return res.ok;
  };

  const voice: LeadVoice = createLeadVoice({
    ...opts.voice,
    workspaceId: opts.workspaceId,
    author: opts.author,
    getContext: context,
    agent: () => client.state().lead?.agentId,
    onChange: (v) => {
      heard = v;
      keepVoice(v.phase !== 'off');
      render();
    },
  });
  const stopListening = (): void => voice.stop();
  const startListening = (): void => {
    ui.notice = '';
    voice.start();
  };

  const grow = (from: DOMRect | null): void => {
    const pane = view.pane;
    if (!from || reduced() || typeof pane.animate !== 'function') return;
    const to = pane.getBoundingClientRect();
    if (!to.width || !to.height) return;
    pane.animate(
      [
        {
          transformOrigin: 'top left',
          transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
        },
        { transformOrigin: 'top left', transform: 'none' },
      ],
      { duration: GROW_MS, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  };

  const openPane = (from: DOMRect | null, focus = true): void => {
    ui.open = true;
    ui.bar = false;
    keepOpen(true);
    render();
    grow(from);
    if (focus) view.composer.focus();
  };

  const closeAll = (): void => {
    ui.open = false;
    ui.bar = false;
    keepOpen(false);
    stopListening();
    render();
  };

  const inMeeting = (): boolean => !!client.state().meeting;

  const onAgent = (): void => {
    if (woke) {
      woke = false;
      return;
    }
    if (ui.open && !inMeeting()) {
      if (voice.state().phase !== 'off') stopListening();
      else startListening();
      return;
    }
    if (ui.open || ui.bar) {
      closeAll();
      return;
    }
    if (readLeadChatMode(storage) === 'voice' && !inMeeting()) {
      ui.bar = true;
      startListening();
      render();
      return;
    }
    openPane(view.button.getBoundingClientRect());
    if (!inMeeting()) startListening();
  };

  const sendTyped = async (): Promise<void> => {
    const text = view.composer.value.trim();
    if (!text) return;
    view.send.disabled = true;
    if (await deliver(text, 'chat')) view.composer.value = '';
    view.send.disabled = view.composer.value.trim() === '';
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && (ui.open || ui.bar)) closeAll();
  };
  /** A full-screen panel making way for a page: listening goes on in the bar. */
  const onLeave = (): void => {
    if (voice.state().phase === 'off' || inMeeting()) {
      closeAll();
      return;
    }
    ui.open = false;
    ui.bar = true;
    keepOpen(false);
    render();
  };
  /** Any tap is the gesture a carried-on voice may be waiting for. The page
   *  asked for a tap anywhere, so a tap that woke it on the agent button is
   *  that tap and does not also turn voice off. */
  let woke = false;
  const onPageTap = (): void => {
    woke = voice.wake();
  };
  const onHidePage = (): void => {
    hiding = true;
  };
  const onShowPage = (): void => {
    hiding = false;
  };

  view.button.addEventListener('click', onAgent);
  view.bar.addEventListener('click', () => openPane(view.bar.getBoundingClientRect()));
  view.close.addEventListener('click', closeAll);
  view.pane.addEventListener(LEAVE_EVENT, onLeave);
  doc.addEventListener('click', onPageTap, true);
  win.addEventListener('pagehide', onHidePage);
  win.addEventListener('pageshow', onShowPage);
  view.send.addEventListener('click', () => void sendTyped());
  view.list.addEventListener('scroll', () => olderIfAtTop(true), { passive: true });
  view.composer.addEventListener('input', () => {
    view.send.disabled = view.composer.value.trim() === '';
    view.composer.style.height = 'auto';
    view.composer.style.height = `${view.composer.scrollHeight}px`;
  });
  view.composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendTyped();
    }
  });
  doc.addEventListener('keydown', onKey);
  meet = wireLeadMeeting({
    document: doc,
    workspaceId: opts.workspaceId,
    author: opts.author,
    client,
    view,
    ...(opts.getContext ? { getContext: opts.getContext } : {}),
    session,
    ...(opts.meeting ? { seams: opts.meeting } : {}),
    changed: render,
    openPane: () => {
      if (!ui.open) openPane(null, false);
    },
    notice: (text) => {
      ui.notice = text;
      render();
    },
  });
  meet.sync();
  const onResize = (): void => view.place();
  win.addEventListener('resize', onResize);
  // The on-screen keyboard moves only the visual viewport (lead-chat-keyboard.ts).
  win.visualViewport?.addEventListener('resize', onResize);
  win.visualViewport?.addEventListener('scroll', onResize);
  render();

  return {
    view,
    startMeeting() {
      if (!ui.open) openPane(view.button.getBoundingClientRect(), false);
      if (!client.state().meeting) meet?.wizard.show();
    },
    destroy() {
      meet?.destroy();
      voice.destroy();
      client.close();
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('click', onPageTap, true);
      win.removeEventListener('pagehide', onHidePage);
      win.removeEventListener('pageshow', onShowPage);
      win.removeEventListener('resize', onResize);
      win.visualViewport?.removeEventListener('resize', onResize);
      win.visualViewport?.removeEventListener('scroll', onResize);
      view.destroy();
      if (!opts.dock) host.remove();
    },
  };
}
