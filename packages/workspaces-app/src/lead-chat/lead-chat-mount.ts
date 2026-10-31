/**
 * The lead chat on a page: the agent button, its bar and its panel, wired to
 * the board's conversation with its lead (`lead-chat-client.ts`).
 *
 * What a tap on the agent button does is this device's choice
 * (`lead-chat-mode.ts`), read at the tap:
 *   - Chat first: the panel opens at once with the cursor in its composer.
 *   - Voice first: the bar comes out and the page starts listening; every
 *     line heard goes to the lead as it ends.
 * While anything is out, the next tap closes it and stops listening. A tap
 * on the bar grows it into the panel.
 *
 * Listening is the board mic's own path (`lead-chat-voice.ts`): the
 * microphone streams to this server over the converse socket, which hears it
 * and hands each question to the lead alone. The server writes the spoken
 * turn and the lead's answer into the chat, so they arrive on the same stream
 * as a typed message, and the answer is also said aloud.
 *
 * The button is drawn only for a reader who may talk to the lead — the
 * board's owner — so nobody else is offered a composer that refuses.
 */
import type { VoiceContext } from '../voice-capture.ts';
import { type LeadChatClient, createLeadChatClient } from './lead-chat-client.ts';
import { type LeadMeetingSeams, wireLeadMeeting } from './lead-chat-meeting-wiring.ts';
import { type ModeStorage, deviceStorage, readLeadChatMode } from './lead-chat-mode.ts';
import { type LeadChatView, createLeadChatView } from './lead-chat-view.ts';
import {
  type LeadVoice,
  type LeadVoiceOpts,
  type LeadVoiceState,
  createLeadVoice,
} from './lead-chat-voice.ts';

export interface LeadChatMountOpts {
  workspaceId: string;
  author: { id: string; name: string; kind?: string };
  /** Where the reader is, read at each send. */
  getContext?: () => VoiceContext | undefined;
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
  const view = createLeadChatView({
    document: doc,
    buttonHost: host,
    placement: opts.dock ? 'dock' : 'float',
  });
  // A floated button sits under the coach's card; this keeps the card above it.
  if (!opts.dock) doc.documentElement.style.setProperty('--lc-agent-room', '56px');
  const client =
    opts.client ??
    createLeadChatClient({
      workspaceId: opts.workspaceId,
      ...(opts.stream ? { stream: opts.stream } : {}),
    });
  const storage = opts.storage === undefined ? deviceStorage() : opts.storage;
  const reduced =
    opts.reducedMotion ?? (() => win.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  const ui = { open: false, bar: false, notice: '' };
  let heard: LeadVoiceState = { phase: 'off', heard: '', notice: '' };

  const render = (): void => {
    const s = client.state();
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

  const deliver = async (text: string, via: 'chat' | 'voice'): Promise<boolean> => {
    const res = await client.send(text, opts.author, opts.getContext?.(), via);
    ui.notice = res.ok ? '' : 'Not sent. Check the connection and try again.';
    render();
    return res.ok;
  };

  const voice: LeadVoice = createLeadVoice({
    ...opts.voice,
    workspaceId: opts.workspaceId,
    author: opts.author,
    getContext: () => opts.getContext?.(),
    agent: () => client.state().lead?.agentId,
    onChange: (v) => {
      heard = v;
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
    render();
    grow(from);
    if (focus) view.composer.focus();
  };

  const closeAll = (): void => {
    ui.open = false;
    ui.bar = false;
    stopListening();
    render();
  };

  const onAgent = (): void => {
    if (ui.open || ui.bar) {
      closeAll();
      return;
    }
    if (readLeadChatMode(storage) === 'voice') {
      ui.bar = true;
      startListening();
      render();
      return;
    }
    openPane(view.button.getBoundingClientRect());
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

  view.button.addEventListener('click', onAgent);
  view.bar.addEventListener('click', () => openPane(view.bar.getBoundingClientRect()));
  view.close.addEventListener('click', closeAll);
  view.mic.addEventListener('click', () => {
    if (voice.state().phase !== 'off') stopListening();
    else startListening();
  });
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
    session: opts.session === undefined ? tabStorage(win) : opts.session,
    ...(opts.meeting ? { seams: opts.meeting } : {}),
    changed: render,
    openPane: () => {
      if (!ui.open) openPane(null, false);
    },
    paneOpen: () => ui.open,
    notice: (text) => {
      ui.notice = text;
      render();
    },
  });
  meet.sync();
  const onResize = (): void => view.place();
  win.addEventListener('resize', onResize);
  render();

  return {
    view,
    destroy() {
      meet?.destroy();
      voice.destroy();
      client.close();
      doc.removeEventListener('keydown', onKey);
      win.removeEventListener('resize', onResize);
      view.destroy();
      if (!opts.dock) host.remove();
    },
  };
}
