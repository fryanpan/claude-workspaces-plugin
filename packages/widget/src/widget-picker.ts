import {
  type Anchor,
  type ElementAnchor,
  anchors,
  escapeHtml as escape,
} from '@claude-workspaces/core';
import { composerNote, composerSignIn } from './widget-auth.ts';
import type { FeedbackWidgetEl } from './widget.ts';

const { hasContext } = anchors;

/**
 * Feedback mode and the composer — arming the picker, deciding what a tap
 * landed on, and putting a comment box beside it.
 *
 * Split out of `widget.ts` unchanged, as the second extraction of B7. The
 * private methods become functions taking the element first; the element
 * still holds the mode state, so the shipped bundle behaves identically.
 *
 * `TAG` and `IGNORE_ATTR` live here rather than in the parent because the
 * two predicates that read them — "did this tap land on our own chrome"
 * (`hitTest`) and "did this mutation come from our own chrome"
 * (`isInOwnChrome`) — are the same question, and an extracted file may not
 * import a value from the file that imports it. `widget.ts` imports both
 * names back.
 */
export const TAG = 'claude-feedback-widget';
export const IGNORE_ATTR = 'data-feedback-widget';

// The FAB is a MODE toggle, not a menu: one click arms it, every click on
// the page after that composes a comment, and it stays armed until the FAB
// is clicked again (or Escape with no composer open). Modeled on the
// comment mode in Claude Desktop artifacts — toggle on, click to place a
// bubble, type — because the whole point is fewer clicks per comment.

export function toggleFeedbackMode(el: FeedbackWidgetEl): void {
  if (el.feedbackMode) exitFeedbackMode(el);
  else enterFeedbackMode(el);
}

/**
 * The width below which the mode opens as a PROMPT rather than as a composer.
 *
 * A layout question, not a device one: it asks whether there is room to float
 * a 300px composer beside the thing being commented on without covering it.
 * (Width cannot identify a device — zoom moves it — which is why nothing here
 * concludes anything about the reader from it.)
 */
const PHONE_MAX = 1100;
export function isPhoneFace(): boolean {
  return window.innerWidth <= PHONE_MAX;
}

/**
 * The anchor a draft starts on before an element has been picked: the page.
 *
 * Entering the mode has to give you somewhere to type — that is behaviour 3 —
 * and at that moment nothing has been pointed at. A subject anchor is exactly
 * "this comment is about the thing as a whole", it cannot break, and tapping
 * an element afterwards re-anchors the SAME draft rather than starting a new
 * one.
 */
function subjectAnchor(): Anchor {
  return { kind: 'subject' };
}

/**
 * Enter posts; Shift+Enter is a newline.
 *
 * `isComposing` is checked because an IME's Enter picks a candidate — eating
 * that keystroke posts a half-typed word and loses the rest.
 */
export function submitOnEnter(ta: HTMLTextAreaElement, submit: () => void): void {
  ta.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
    ev.preventDefault();
    submit();
  });
}

export function enterFeedbackMode(el: FeedbackWidgetEl): void {
  if (el.feedbackMode) return;
  el.feedbackMode = true;
  // The speech-bubble cursor rides a body class (see injectLightStyles) so
  // it beats per-element cursor styles the host page declares.
  document.body.classList.add('cfw-feedback-mode');
  // iOS Safari fires `click` reliably only on elements that have
  // `cursor: pointer` (or are a button/anchor). The mode needs to catch
  // taps on arbitrary mockup elements — `<div>`s, custom components,
  // etc. — that DON'T have a clickable cursor style. A window-level click
  // listener silently no-ops on those.
  //
  // Pointer events fix it: `pointerup` fires for mouse, touch, and pen
  // regardless of cursor style. Bonus: `touch-action: manipulation` on the
  // body suppresses the 300ms double-tap-zoom delay on iOS so taps
  // register instantly.
  const prevTouchAction = document.body.style.touchAction;
  document.body.style.touchAction = 'manipulation';
  el.togglePanel(false);
  const fab = el.shadow.querySelector('.fab');
  fab?.setAttribute('aria-pressed', 'true');
  fab?.classList.add('open');

  // The banner names the mode and holds the way out — the cursor alone
  // says "you're in a mode" but not how to leave it.
  const banner = document.createElement('div');
  banner.className = 'picker-banner';
  banner.innerHTML = `
      <span>Click anything to comment.</span>
      <button class="picker-cancel">Done (Esc)</button>
    `;
  el.shadow.appendChild(banner);
  // The mode's resting state where there is room for one: a focused field on
  // the page you are looking at. Round 3's answer — "entering comment mode
  // focuses the text input" — and the reason Done lives up here on the banner
  // and never beside Post: the two read as the same button when adjacent.
  // At phone width the banner IS the prompt and the field opens on the tap,
  // because a composer over a 430px page covers the thing being commented on.
  if (!isPhoneFace()) openDefaultComposer(el);

  const onMove = (ev: PointerEvent) => {
    // Skip hover-highlight on touch — fingers don't "hover," and
    // repainting outlines along a drag is just visual noise.
    if (ev.pointerType === 'touch') return;
    // A composer open means an element is already chosen. Repainting the
    // hover under it would take the outline off the element the comment is
    // being written about, which is the one the reader is looking at.
    if (el.shadow.querySelector('.composer')) return;
    const t = hitTest(ev);
    el.hoverEl = t;
    if (t) setHighlight(el, t);
    else clearHighlight(el);
  };
  const onTap = (ev: PointerEvent) => {
    const t = hitTest(ev);
    // Own chrome (FAB, composer, pins) keeps its normal behavior — a
    // preventDefault here would break the very controls the mode relies on.
    if (!t) return;
    ev.preventDefault();
    ev.stopPropagation();
    // Touch never hovers, so the tap is the only chance to show WHICH
    // element the composer is about.
    el.hoverEl = t;
    setHighlight(el, t);
    openComposerForElement(el, t, ev.clientX, ev.clientY);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    // First Escape backs out of the comment being written; the next one
    // exits the mode. Matches every modal-inside-a-mode convention.
    const composer = el.shadow.querySelector('.composer');
    if (composer) {
      closeComposer(el, composer);
      return;
    }
    exitFeedbackMode(el);
  };
  banner.querySelector('.picker-cancel')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    exitFeedbackMode(el);
  });
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onTap, true);
  window.addEventListener('keydown', onKey, true);

  el.modeCleanup = () => {
    document.body.classList.remove('cfw-feedback-mode');
    document.body.style.touchAction = prevTouchAction;
    clearHighlight(el);
    el.hoverEl = null;
    banner.remove();
    fab?.setAttribute('aria-pressed', 'false');
    fab?.classList.remove('open');
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onTap, true);
    window.removeEventListener('keydown', onKey, true);
  };
}

/** A composer left open survives the exit — mid-typed text is not the
 *  mode's to discard. */
export function exitFeedbackMode(el: FeedbackWidgetEl): void {
  if (!el.feedbackMode) return;
  el.feedbackMode = false;
  el.modeCleanup?.();
  el.modeCleanup = null;
}

function hitTest(ev: MouseEvent): HTMLElement | null {
  const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
  if (!el) return null;
  // skip widget chrome
  if (el.closest(`[${IGNORE_ATTR}]`) || el.tagName === TAG.toUpperCase()) return null;
  return el;
}

/** The other half of `hitTest`'s question, asked of a mutation record rather
 *  than a pointer: writes the widget made itself must not re-enter the
 *  render loop. */
export function isInOwnChrome(node: Node): boolean {
  let el: Node | null = node;
  while (el) {
    if (el.nodeType === 1) {
      const e = el as Element;
      if (
        e.hasAttribute?.(IGNORE_ATTR) ||
        e.tagName === TAG.toUpperCase() ||
        e.id === 'cfw-light-styles'
      ) {
        return true;
      }
    }
    el = el.parentNode;
  }
  return false;
}

const HIGHLIGHT_OUTLINE = '2px solid #2e7dd7';

/**
 * The outline is a SELECTION: at most one element on the page wears it, and
 * the state that says which one lives here rather than on the widget, so two
 * widgets embedded on one page still paint one highlight between them.
 *
 * What the page had before is remembered off-DOM. It used to ride a
 * `data-cfw-prev-outline` attribute, which had two costs. A second
 * `highlight()` on an element already highlighted — every pointermove within
 * one element fired one — re-read `style.outline` and saved the picker's own
 * colour as the "previous" value, so restoring painted the highlight back on
 * for good. And an element fingerprint captures every `data-*` attribute, so
 * the bookkeeping was copied into the anchor of every thread posted from a
 * hovered element.
 */
const prevOutline = new WeakMap<HTMLElement, string>();
let highlighted: HTMLElement | null = null;
/** The widget whose pick the current outline belongs to. Two widgets on one
 *  page still paint one highlight between them, but only the one that took
 *  it may give it back — otherwise a widget closing its own composer strips
 *  the outline off the element the OTHER widget is still composing about. */
let highlightOwner: FeedbackWidgetEl | null = null;

function setHighlight(owner: FeedbackWidgetEl, target: HTMLElement | null): void {
  if (highlighted !== target) {
    if (highlighted) {
      highlighted.style.outline = prevOutline.get(highlighted) ?? '';
      prevOutline.delete(highlighted);
    }
    highlighted = target;
    if (target) {
      prevOutline.set(target, target.style.outline);
      target.style.outline = HIGHLIGHT_OUTLINE;
    }
  }
  // Re-taken by whoever picked it last, even when the element did not move.
  highlightOwner = target ? owner : null;
}

/** Take the outline away only if this widget is the one wearing it. */
function clearHighlight(owner: FeedbackWidgetEl): void {
  if (highlightOwner !== owner) return;
  setHighlight(owner, null);
}

// --- Composer ---

function openComposerForElement(
  widget: FeedbackWidgetEl,
  el: HTMLElement,
  cx: number,
  cy: number,
): void {
  const anchor: ElementAnchor = {
    ...anchors.Element.createAnchor(el),
    ...(hasContext(widget.currentContext) ? { context: { ...widget.currentContext } } : {}),
  };
  showComposer(widget, anchor, cx, cy, null);
}

/**
 * The composer the mode opens with, anchored on the page rather than on
 * anything in it. Tapping an element afterwards moves the same draft onto it.
 */
export function openDefaultComposer(widget: FeedbackWidgetEl): void {
  showComposer(widget, subjectAnchor(), window.innerWidth / 2 - 162, 96, null);
}

function showComposer(
  el: FeedbackWidgetEl,
  anchor: Anchor,
  cx: number,
  cy: number,
  replyTo: string | null,
): void {
  const existing = el.shadow.querySelector('.composer') as HTMLElement | null;
  // The draft moves with you. Tapping an element while a draft is open
  // RE-ANCHORS what you were writing rather than throwing it away and
  // starting again — the composer is replaced, the sentence is not.
  const carried = (existing?.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? '';
  existing?.remove();
  const composer = document.createElement('div');
  composer.className = 'composer';
  composer.style.left = `${Math.max(8, Math.min(cx + 12, window.innerWidth - 320))}px`;
  composer.style.top = `${Math.max(8, Math.min(cy + 12, window.innerHeight - 200))}px`;
  // A subject anchor points AT the page rather than into it, so there is no
  // quotation to show — it says what it is about instead.
  const snippet =
    anchor.kind === 'subject' ? 'About this page' : (anchor as ElementAnchor).snippet.text;
  composer.innerHTML = `
      <div class="composer-snippet">${escape(snippet)}</div>
      <textarea placeholder="${replyTo ? 'Reply…' : 'Comment on this element…'}" rows="3"></textarea>
      <div class="composer-actions">
        <button class="cancel">Cancel</button>
        <button class="primary submit">Post</button>
      </div>
    `;
  el.shadow.appendChild(composer);
  const ta = composer.querySelector('textarea') as HTMLTextAreaElement;
  ta.value = carried;
  // Synchronously, inside the handler that opened it: deferred to a timeout
  // this is no longer a user gesture and iOS keeps the keyboard down — the
  // field looks focused and nothing can be typed.
  ta.focus();
  ta.setSelectionRange(carried.length, carried.length);
  // Cancel is NOT Done. It throws the draft away and hands you back the mode,
  // so the next element is one tap away; where the mode rests in a composer,
  // that is a fresh empty one. Leaving the mode is the banner's Done, and it
  // never sits beside Post.
  composer.querySelector('.cancel')?.addEventListener('click', () => {
    closeComposer(el, composer);
    if (el.feedbackMode && !replyTo && !isPhoneFace()) openDefaultComposer(el);
  });
  const submit = composer.querySelector('.submit') as HTMLButtonElement;
  // Say it before the first attempt when the widget already knows.
  if (el.signInToWrite && !el.authToken) composerSignIn(el, composer, submit);
  // One post at a time. Disabling the button stops a second CLICK and nothing
  // else: the textarea's Enter handler is still live, and a key held down
  // auto-repeats, so a slow connection could post the same comment several
  // times over. The flag is what both doors read.
  let inFlight = false;
  const post = async (): Promise<void> => {
    const text = ta.value.trim();
    if (inFlight || !text || !el.user) return;
    inFlight = true;
    // A silent await reads as a dead button — say the click landed.
    submit.disabled = true;
    submit.textContent = 'Posting…';
    // A rejected fetch (server unreachable) is a failed post like any
    // other — without the catch it would strand the button at "Posting…".
    let posted = false;
    try {
      posted = replyTo ? await el.postReply(replyTo, text) : await el.postNewThread(anchor, text);
    } catch {}
    inFlight = false;
    if (!posted) {
      // Kept on failure, with the text still in it.
      submit.disabled = false;
      submit.textContent = 'Post';
      if (el.signInToWrite && !el.authToken) composerSignIn(el, composer, submit);
      else composerNote(composer, 'Couldn’t post — try again.');
      return;
    }
    closeComposer(el, composer);
    // Commenting is a MODE: posting hands you straight back to it, so several
    // comments in a row cost one entry and one exit. Round 3 dropped this at
    // tablet width and the next element was not tappable until the FAB had
    // been pressed twice.
    if (el.feedbackMode && !replyTo && !isPhoneFace()) openDefaultComposer(el);
  };
  submit.addEventListener('click', () => void post());
  submitOnEnter(ta, () => void post());
}

/** Dismissing the composer — cancelled, escaped or posted — takes the
 *  element's outline with it: nothing on the page is selected any more. */
function closeComposer(el: FeedbackWidgetEl, composer: Element): void {
  composer.remove();
  clearHighlight(el);
  el.hoverEl = null;
}
