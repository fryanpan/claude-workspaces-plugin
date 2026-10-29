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
 * Listening is the browser's own speech recognition, so it costs nothing and
 * needs no socket: what is heard is sent as a message marked as said. The
 * lead's answer arrives as text in the same chat. Spoken replies stay with
 * the board's own mic.
 *
 * The button is drawn only for a reader who may talk to the lead — the
 * board's owner — so nobody else is offered a composer that refuses.
 */
import {
  type RecognitionLike,
  type VoiceContext,
  defaultRecognitionFactory,
} from '../voice-capture.ts';
import { type LeadChatClient, createLeadChatClient } from './lead-chat-client.ts';
import { type ModeStorage, deviceStorage, readLeadChatMode } from './lead-chat-mode.ts';
import { type LeadChatView, createLeadChatView } from './lead-chat-view.ts';

export interface LeadChatMountOpts {
  workspaceId: string;
  author: { id: string; name: string; kind?: string };
  /** Where the reader is, read at each send. */
  getContext?: () => VoiceContext | undefined;
  /** A slot in the board's dock; omitted, the button floats bottom-left. */
  dock?: HTMLElement;
  document?: Document;
  /** Injected by tests. */
  client?: LeadChatClient;
  storage?: ModeStorage | null;
  createRecognition?: () => RecognitionLike | null;
  reducedMotion?: () => boolean;
}

export interface LeadChatMount {
  view: LeadChatView;
  destroy(): void;
}

const GROW_MS = 200;

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
  const client = opts.client ?? createLeadChatClient({ workspaceId: opts.workspaceId });
  const storage = opts.storage === undefined ? deviceStorage() : opts.storage;
  const createRecognition = opts.createRecognition ?? defaultRecognitionFactory;
  const reduced =
    opts.reducedMotion ?? (() => win.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  const ui = { open: false, bar: false, listening: false, heard: '', notice: '' };
  let rec: RecognitionLike | null = null;

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
      listening: ui.listening,
      heard: ui.heard,
      notice: ui.notice,
    });
  };
  client.onChange(render);

  const deliver = async (text: string, via: 'chat' | 'voice'): Promise<boolean> => {
    const res = await client.send(text, opts.author, opts.getContext?.(), via);
    ui.notice = res.ok ? '' : 'Not sent. Check the connection and try again.';
    render();
    return res.ok;
  };

  const stopListening = (): void => {
    ui.listening = false;
    ui.heard = '';
    const r = rec;
    rec = null;
    if (r) {
      r.onend = null;
      r.onresult = null;
      try {
        r.stop();
      } catch {
        // Already stopped.
      }
    }
  };

  const startListening = (): void => {
    if (ui.listening) return;
    const r = createRecognition();
    if (!r) {
      ui.notice = 'This browser cannot listen. Type to your lead instead.';
      render();
      return;
    }
    rec = r;
    ui.listening = true;
    ui.notice = '';
    r.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (!res) continue;
        const said = res[0].transcript.trim();
        if (res.isFinal) {
          if (said) void deliver(said, 'voice');
        } else {
          interim += `${said} `;
        }
      }
      ui.heard = interim.trim();
      render();
    };
    r.onerror = (ev) => {
      const code = (ev as { error?: string } | null)?.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        stopListening();
        ui.notice = 'The microphone is blocked for this page.';
        render();
      }
    };
    // Recognition ends itself after a silence; listening goes on until the
    // reader stops it.
    r.onend = () => {
      if (rec !== r) return;
      try {
        r.start();
      } catch {
        stopListening();
        render();
      }
    };
    try {
      r.start();
    } catch {
      stopListening();
    }
    render();
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

  const openPane = (from: DOMRect | null): void => {
    ui.open = true;
    ui.bar = false;
    render();
    grow(from);
    view.composer.focus();
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
    if (ui.listening) stopListening();
    else startListening();
    render();
  });
  view.send.addEventListener('click', () => void sendTyped());
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
  const onResize = (): void => view.place();
  win.addEventListener('resize', onResize);
  render();

  return {
    view,
    destroy() {
      stopListening();
      client.close();
      doc.removeEventListener('keydown', onKey);
      win.removeEventListener('resize', onResize);
      view.destroy();
      if (!opts.dock) host.remove();
    },
  };
}
