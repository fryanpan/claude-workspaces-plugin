import type { Anchor, ElementAnchor, VoiceTarget } from '@claude-workspaces/core';
import { hasContext } from '@claude-workspaces/core/anchor/context';
import { createAnchor } from '@claude-workspaces/core/anchor/element';
import { SIGN_IN_NOTE, type WidgetMic } from '../widget-mic.ts';
import type { FeedbackWidgetEl } from '../widget.ts';
import { startPcmCapture } from './voice-audio.ts';
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
 * elements the server picks from, a tap that pins the next words to an
 * element, and Move's tap that re-points a comment.
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

/** A short name a person would recognise for a catalog entry. */
function nameOf(t: VoiceTarget | undefined): string {
  if (!t) return 'This page';
  const words = t.label || t.text || t.hint?.replace(/[#.]/g, ' ').trim() || `<${t.tag}>`;
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
  const session = new VoiceSession({
    url,
    openSocket: opts.openSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike),
    startCapture: opts.startCapture ?? startPcmCapture,
    poster: widgetPoster(widget),
    catalog,
    anchorFor,
    onChange: () => draw(),
    onLevel: (l) => view.level(l),
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
    name: (t) => nameOf(t === null ? undefined : targets.get(t)),
    author: () => widget.user?.name ?? 'Anonymous',
    clipUrl: (clip) => `${widget.opts.serverUrl.replace(/^ws/, 'http')}${clip}`,
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

  // --- The page, while recording: taps pin, Move re-points, changes re-describe ---

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

  const onClick = (ev: MouseEvent): void => {
    if (ours(ev) || widget.feedbackMode) return;
    ev.preventDefault();
    ev.stopPropagation();
    let target = targetAt(ev.target);
    if (target === null) {
      // An element added since the last description: the server has to hear
      // of it before a pin names its index.
      session.refreshTargets();
      target = targetAt(ev.target);
    }
    if (view.picking) {
      const key = view.picking;
      view.picking = null;
      session.move(key, target);
    } else {
      session.pin(target);
    }
    if (highlight) highlight.hidden = true;
  };
  const onHover = (ev: PointerEvent): void => {
    if (!view.picking && session.state === 'idle') return;
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
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    if (view.picking) {
      view.picking = null;
      draw();
    } else {
      session.stop();
    }
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
