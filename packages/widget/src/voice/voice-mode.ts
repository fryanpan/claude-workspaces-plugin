import type { Anchor, ElementAnchor, VoiceTarget } from '@claude-workspaces/core';
import { hasContext } from '@claude-workspaces/core/anchor/context';
import { createAnchor } from '@claude-workspaces/core/anchor/element';
import { clipAudio } from '../widget-auth.ts';
import { SIGN_IN_NOTE, type WidgetMic } from '../widget-mic.ts';
import type { FeedbackWidgetEl } from '../widget.ts';
import { hostCapture, startPcmCapture } from './voice-audio.ts';
import { makeContext } from './voice-loader.ts';
import { widgetPoster } from './voice-post.ts';
import { type SocketLike, VoiceSession, type VoiceSessionDeps } from './voice-session.ts';
import { collectTargets } from './voice-targets.ts';
import { VoiceView } from './voice-ui.ts';

/**
 * Voice feedback on a widget: tap the mic, talk about the page, and what you
 * say lands as comments on the things you named.
 *
 * The glue between the three halves — `VoiceSession` (the socket and the
 * threads), `VoiceView` (what is drawn) and the page itself: the catalog of
 * elements the server picks from, and Move's tap that re-points a comment.
 * Every other click and key reaches the page, so the reader keeps using it
 * while they talk.
 *
 * Mounted on a mic `addMic` already made, so the board (which imports this)
 * and a mock page (which fetches it as `voice.js` on the first tap, see
 * `voice-loader.ts`) share one button and one set of hover labels.
 */

export interface VoiceMode {
  session: VoiceSession;
  view: VoiceView;
  /** Start, or Stop. `context` is an AudioContext made inside the tap. */
  toggle(context?: AudioContext): void;
}

/** The mic's hover label while it is a Stop button. */
export const STOP_LABEL = 'Stop recording';

/** How long the page must be still before a changed page is described again. */
const RECATALOG_MS = 1500;

export interface VoiceModeOpts {
  openSocket?: (url: string) => SocketLike;
  startCapture?: VoiceSessionDeps['startCapture'];
  shown?: (el: HTMLElement) => boolean;
}

const short = (el: Element | null | undefined): string => {
  const words = (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return words.length <= 40 ? words : '';
};

/**
 * What a person calls an element with no label of its own, when its words
 * alone would read as a value: a row of two by its first cell ("Harborlight
 * launch date", not "... September 30"), the value in such a row by the cell
 * before it, and a section by its heading. A button's words are its name,
 * whatever stands before it.
 */
function rowLabel(el: HTMLElement | null): string {
  if (!el) return '';
  const first = el.firstElementChild;
  if (first && /^H[1-6]$/.test(first.tagName)) return short(first);
  if (
    el.children.length === 2 &&
    !Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim())
  ) {
    return short(first);
  }
  const before = el.previousElementSibling;
  if (!before || el.parentElement?.children.length !== 2) return '';
  if (/^(button|a|input|select|textarea|label|summary|h[1-6])$/i.test(el.tagName)) return '';
  return short(before);
}

/** A short name a person would recognise for a catalog entry. */
function nameOf(t: VoiceTarget | undefined, el: HTMLElement | null): string {
  if (!t) return 'This page';
  const words =
    t.label || rowLabel(el) || t.text || t.hint?.replace(/[#.]/g, ' ').trim() || `<${t.tag}>`;
  return words.length > 40 ? `${words.slice(0, 39)}…` : words;
}

const mounted = new WeakMap<FeedbackWidgetEl, VoiceMode>();

/** Idempotent: a second call on the same widget hands back the first. */
export function mountVoiceMode(
  widget: FeedbackWidgetEl,
  mic: WidgetMic,
  opts: VoiceModeOpts = {},
): VoiceMode {
  const had = mounted.get(widget);
  if (had) return had;
  const ids = new Map<Element, number>();
  let byIndex = new Map<number, HTMLElement>();
  let targets = new Map<number, VoiceTarget>();
  const catalog = (): VoiceTarget[] => {
    const c = collectTargets(document.body, opts.shown, ids);
    byIndex = c.elements;
    targets = new Map(c.targets.map((t) => [t.i, t]));
    return c.targets;
  };
  const element = (target: number | null): HTMLElement | null => {
    if (target === null) return null;
    const el = byIndex.get(target);
    return el?.isConnected ? el : null;
  };
  const anchorFor = (target: number | null): Anchor => {
    const el = element(target);
    if (!el) return { kind: 'subject' };
    const a: ElementAnchor = createAnchor(el);
    return hasContext(widget.currentContext) ? { ...a, context: { ...widget.currentContext } } : a;
  };
  const enc = encodeURIComponent;
  const url = `${widget.opts.serverUrl}/workspaces/${enc(widget.opts.workspaceId)}/docs/${enc(widget.opts.docId)}/voice`;

  const { button, readout } = mic;
  const idleIcon = button.innerHTML;
  const idleTip = button.dataset.tip ?? '';
  // Inside a served mock's frame the microphone is the host page's, and it
  // arrives through the socket this session opened (`hostCapture`).
  let socket: SocketLike | null = null;
  const session = new VoiceSession({
    url,
    openSocket: (u) => {
      socket = opts.openSocket
        ? opts.openSocket(u)
        : // The tailnet widget door asks every route but its two static
          // scripts for the reviewer's board token, and a browser cannot set
          // a header on a WebSocket — so it rides as the one subprotocol
          // offered, which is what the door reads. Only a BOARD token, never
          // a session one, for the reason the doc socket gives in
          // `widget.ts`: a session token that died on a localhost socket
          // would turn a read-only socket into a refused one.
          (new WebSocket(
            u,
            widget.authToken?.startsWith('wt2.') ? widget.authToken : undefined,
          ) as unknown as SocketLike);
      return socket;
    },
    startCapture:
      opts.startCapture ??
      ((o) => (socket && 'cwMic' in socket ? hostCapture(socket, o) : startPcmCapture(o))),
    poster: widgetPoster(widget),
    catalog,
    anchorFor,
    onChange: () => draw(),
    refusedNote: () => {
      if (!widget.signInToWrite || widget.authToken) return null;
      // Appended: `addMic` made the retry slot hold everything put in it.
      widget.retryAfterSignIn = () => session.retryRefused();
      return SIGN_IN_NOTE;
    },
  });
  const view: VoiceView = new VoiceView({
    session,
    shadow: widget.shadow,
    element,
    name: (t) => nameOf(t === null ? undefined : targets.get(t), element(t)),
    clipAudio: (clip) => clipAudio(widget, clip),
    onMove: (key) => {
      view.picking = key;
      draw();
    },
  });

  let lastState = session.state;
  function draw(): void {
    const on = session.state !== 'idle';
    button.classList.toggle('voice-active', on);
    button.setAttribute('aria-pressed', String(on));
    if (on !== (lastState !== 'idle')) {
      button.innerHTML = on ? '<span class="vstop"></span>' : idleIcon;
      // Its label says what a tap does now.
      button.dataset.tip = on ? STOP_LABEL : idleTip;
      if (on) watchPage();
      else unwatchPage();
    }
    lastState = session.state;
    readout.textContent = session.note ?? '';
    readout.classList.toggle('hidden', !session.note);
    if (!on && view.picking && !session.comments.get(view.picking)?.posted) view.picking = null;
    view.render();
  }

  // --- The page, while recording: Move's tap re-points, changes re-describe ---

  let highlight: HTMLDivElement | null = null;
  let recatalog: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver((records) => {
    if (records.every((r) => widget.contains(r.target) || r.target === widget)) return;
    if (recatalog) clearTimeout(recatalog);
    recatalog = setTimeout(() => session.refreshTargets(), RECATALOG_MS);
  });

  /** The element a tap means: the nearest one the catalog names. */
  const targetAt = (node: EventTarget | null): number | null => {
    for (let el = node instanceof Element ? node : null; el; el = el.parentElement) {
      const i = ids.get(el);
      if (i !== undefined && byIndex.get(i) === el) return i;
    }
    return null;
  };
  const ours = (ev: Event): boolean => ev.composedPath().includes(widget);

  // Only an armed Move takes a click; any other is the page's.
  const onClick = (ev: MouseEvent): void => {
    const key = view.picking;
    if (!key || ours(ev) || widget.feedbackMode) return;
    ev.preventDefault();
    ev.stopPropagation();
    let target = targetAt(ev.target);
    if (target === null) {
      // An element added since the last description: the server has to hear
      // of it before a move names its index.
      session.refreshTargets();
      target = targetAt(ev.target);
    }
    view.picking = null;
    session.move(key, target);
    if (highlight) highlight.hidden = true;
  };
  const onHover = (ev: PointerEvent): void => {
    if (!view.picking) return;
    const el = element(ours(ev) ? null : targetAt(ev.target));
    if (!highlight) {
      highlight = document.createElement('div');
      highlight.className = 'vhl';
      widget.shadow.append(highlight);
    }
    highlight.hidden = !el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    Object.assign(highlight.style, {
      left: `${r.left - 3}px`,
      top: `${r.top - 3}px`,
      width: `${r.width + 6}px`,
      height: `${r.height + 6}px`,
    });
  };
  // Escape cancels an armed Move. Otherwise it is the page's, and the
  // recording goes on: the Stop button is how a recording ends.
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || !view.picking) return;
    ev.preventDefault();
    view.picking = null;
    if (highlight) highlight.hidden = true;
    draw();
  };

  function watchPage(): void {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener('click', onClick, true);
    document.addEventListener('pointermove', onHover, true);
    window.addEventListener('keydown', onKey, true);
  }
  function unwatchPage(): void {
    observer.disconnect();
    if (recatalog) clearTimeout(recatalog);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('pointermove', onHover, true);
    window.removeEventListener('keydown', onKey, true);
    if (highlight) highlight.hidden = true;
  }

  const toggle = (context?: AudioContext): void => {
    if (session.state === 'idle') {
      void session.start(context);
    } else {
      view.picking = null;
      session.stop();
    }
  };
  button.addEventListener('click', () =>
    toggle(session.state === 'idle' ? makeContext() : undefined),
  );
  draw();
  const mode = { session, view, toggle };
  mounted.set(widget, mode);
  return mode;
}
