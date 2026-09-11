import {
  type Anchor,
  type ElementAnchor,
  anchors,
  escapeHtml as escape,
} from '@claude-workspaces/core';
import { composerNote, composerSignIn } from './widget-auth.ts';
import { cardTarget, drafts, isPhoneFace, keepDraft, placeCards } from './widget-card.ts';
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
  // says "you're in a mode" but not how to leave it. At phone width it is the
  // compact panel along the bottom instead of a pill across the top, where
  // it sat over the page's own title; the tick says a post landed.
  const phone = isPhoneFace();
  const banner = document.createElement('div');
  banner.className = phone ? 'picker-banner quick' : 'picker-banner';
  banner.innerHTML =
    `<span>${phone ? 'Tap' : 'Click'} anything to comment.</span>` +
    '<span class="tick" hidden>Saved</span>' +
    `<button class="picker-cancel">Done${phone ? '' : ' (Esc)'}</button>`;
  el.shadow.appendChild(banner);
  // The faint line from a card to its element (see `widget-card.ts`).
  const lead = document.createElement('div');
  lead.className = 'leader';
  el.shadow.appendChild(lead);
  // The mode's resting state where there is room for one: a focused field on
  // the page you are looking at. Round 3's answer — "entering comment mode
  // focuses the text input" — and the reason Done lives up here on the banner
  // and never beside Post: the two read as the same button when adjacent.
  // At phone width the banner IS the prompt and the field opens on the tap,
  // because a composer over a 430px page covers the thing being commented on.
  if (!phone) openDefaultComposer(el);

  const onMove = (ev: PointerEvent) => {
    // Skip hover-highlight on touch — fingers don't "hover," and
    // repainting outlines along a drag is just visual noise.
    if (ev.pointerType === 'touch') return;
    // A composer about an element means that element is chosen. Repainting
    // the hover would take the outline off the element the comment is being
    // written about, which is the one the reader is looking at. The card the
    // mode RESTS in is about the page, and there the hover is how a pointer
    // shows what a click would pick.
    if (cardTarget.has(el.shadow.querySelector('.composer') as Element)) return;
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
    openComposerForElement(el, t);
  };
  // A finger's press is followed, AFTER its pointerup, by the compatibility
  // mousedown — whose default moves focus to what was pressed. That took the
  // focus straight back off the field the tap had just opened, so typing went
  // nowhere; a mouse's mousedown comes first and was harmless. Cancelling the
  // press on the page stops the compatibility events; our own chrome is left
  // alone, or its fields could not be focused at all.
  const onDown = (ev: PointerEvent) => {
    if (hitTest(ev) || (ev.composedPath()[0] as Element).closest?.('.saved')) ev.preventDefault();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    // First Escape backs out of the comment being written; the next one
    // exits the mode. Matches every modal-inside-a-mode convention.
    const composer = el.shadow.querySelector('.composer');
    if (composer) {
      keepDraft(el);
      closeComposer(el, composer);
      return;
    }
    exitFeedbackMode(el);
  };
  banner.querySelector('.picker-cancel')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    exitFeedbackMode(el);
  });
  // The face is chosen for the width the mode opened at. Turning an iPad to
  // portrait crosses that line, so the mode is opened again on the other
  // face, carrying the draft and the element it is about.
  const onResize = () => {
    if (isPhoneFace() === phone) return;
    const c = el.shadow.querySelector('.composer');
    const t = c ? cardTarget.get(c) : undefined;
    exitFeedbackMode(el);
    enterFeedbackMode(el);
    if (t) {
      el.hoverEl = t;
      setHighlight(el, t);
      openComposerForElement(el, t);
    } else if (drafts.has(el)) openDefaultComposer(el);
  };
  const on = [
    ['pointermove', onMove],
    ['pointerdown', onDown],
    ['pointerup', onTap],
    ['keydown', onKey],
    ['resize', onResize],
  ] as [string, EventListener][];
  for (const [t, f] of on) window.addEventListener(t, f, true);

  el.modeCleanup = () => {
    document.body.classList.remove('cfw-feedback-mode');
    document.body.style.touchAction = prevTouchAction;
    clearHighlight(el);
    el.hoverEl = null;
    // Done means done: nothing of the mode stays on the page — not a card, not
    // an empty composer resting where the mode had been. Typed words are not
    // the mode's to discard, though: they wait for that element to be opened
    // again (Cancel is the one way to drop them).
    keepDraft(el);
    for (const n of el.shadow.querySelectorAll('.composer, .saved, .leader, .picker-banner')) {
      n.remove();
    }
    fab?.setAttribute('aria-pressed', 'false');
    fab?.classList.remove('open');
    for (const [t, f] of on) window.removeEventListener(t, f, true);
  };
}

/** Leaving the mode takes its cards with it, as the mock's Done does. */
export function exitFeedbackMode(el: FeedbackWidgetEl): void {
  if (!el.feedbackMode) return;
  el.feedbackMode = false;
  el.modeCleanup?.();
  el.modeCleanup = null;
}

/** One node of a press's path: is this the widget's own chrome? */
function isOwnChromeNode(node: EventTarget | undefined): boolean {
  const el = node as Element | undefined;
  if (el?.nodeType !== 1) return false;
  return el.tagName === TAG.toUpperCase() || el.hasAttribute?.(IGNORE_ATTR) === true;
}

/**
 * Did this press land on the widget's own controls?
 *
 * Asked of the EVENT, not of the viewport. The press travelled through every
 * node in `composedPath()` on its way to a listener, shadow boundaries
 * included, so the path is the only account of what was actually pressed that
 * no engine and no host page can disagree with.
 *
 * It used to be asked of `document.elementFromPoint(clientX, clientY)`, which
 * is a SECOND hit test against the current layout rather than a record of the
 * first. That worked only because Chromium retargets shadow content to the
 * host, so a press on the composer read back as
 * `<claude-feedback-widget>` and the tag check caught it. Where that second
 * hit test answers with anything else — an engine that hands back the inner
 * shadow node instead of the host, a page that has moved or covered the
 * widget since the press — the widget treats a press on its own Post button
 * as a press on the page: the click is preventDefaulted away and a fresh
 * composer opens ON the button, anchored to the button. That is the reported
 * bug, and it is reproduced in `widget-post-click.test.ts` by giving the page
 * a hit test that does not retarget.
 *
 * The fallback exists for a synthesized event, whose `composedPath()` is
 * empty: `target` alone still catches our chrome in any engine that
 * retargets, and the caller's own viewport check is still behind it.
 */
function pressIsOurs(ev: Event): boolean {
  const path = ev.composedPath();
  if (path.length > 0) return path.some(isOwnChromeNode);
  return isOwnChromeNode(ev.target ?? undefined);
}

function hitTest(ev: MouseEvent): HTMLElement | null {
  // Our own chrome (FAB, banner, composer, dock, pins) answers for itself.
  if (pressIsOurs(ev)) return null;
  const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
  if (!el) return null;
  // skip widget chrome
  if (el.closest(`[${IGNORE_ATTR}],${TAG}`)) return null;
  return el;
}

/** The other half of `hitTest`'s question, asked of a mutation record rather
 *  than a pointer: writes the widget made itself must not re-enter the
 *  render loop. */
export function isInOwnChrome(node: Node): boolean {
  for (let n: Node | null = node; n; n = n.parentNode) {
    if (isOwnChromeNode(n) || (n as Element).id === 'cfw-light-styles') return true;
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

function openComposerForElement(widget: FeedbackWidgetEl, el: HTMLElement): void {
  const anchor: ElementAnchor = {
    ...anchors.Element.createAnchor(el),
    ...(hasContext(widget.currentContext) ? { context: { ...widget.currentContext } } : {}),
  };
  showComposer(widget, anchor, el);
}

/**
 * The composer the mode opens with, anchored on the page rather than on
 * anything in it. Tapping an element afterwards moves the same draft onto it.
 */
export function openDefaultComposer(widget: FeedbackWidgetEl): void {
  showComposer(widget, subjectAnchor(), null);
}

/** How long a post's tick stays up — the saved card, or the panel's. */
const SAVED_MS = 4000;

/**
 * One composer, two faces. Where there is room it is a CARD in the right
 * margin at its element's height (`widget-card.ts` places it). At phone width
 * it is the compact panel along the bottom (`.quick`): one row saying what the
 * comment is on, with Cancel; one row to type in, with Post. The page behind
 * holds still, so the element stays on screen and outlined.
 */
function showComposer(el: FeedbackWidgetEl, anchor: Anchor, target: HTMLElement | null): void {
  const existing = el.shadow.querySelector('.composer') as HTMLElement | null;
  // The draft moves with you. Tapping an element while a draft is open
  // RE-ANCHORS what you were writing rather than throwing it away and
  // starting again — the composer is replaced, the sentence is not.
  // Unless this element has words of its own waiting: then those come back,
  // and the ones being left are kept on the element (or page) they were
  // about, rather than carried over the top of them.
  const key = target ?? el;
  const own = drafts.get(key);
  if (own) keepDraft(el);
  const carried =
    own || (existing?.querySelector('textarea') as HTMLTextAreaElement | null)?.value || '';
  drafts.delete(key);
  existing?.remove();
  const quick = isPhoneFace();
  const composer = document.createElement('div');
  composer.className = quick ? 'composer quick' : 'composer';
  if (target) cardTarget.set(composer, target);
  // A subject anchor points AT the page rather than into it, so there is no
  // quotation to show — it says what it is about instead. An element's quote
  // reads "on <quote>"; the "on" is drawn by the stylesheet, so the text a
  // reader (or a test) takes from the line is the anchor's own words.
  const head = target
    ? `<b>${escape((target.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || (anchor as ElementAnchor).snippet.text)}</b>`
    : 'About this page';
  composer.innerHTML =
    `<div class="composer-snippet">${head}</div>` +
    `<textarea placeholder="Comment on this element…" rows="${quick ? 1 : 3}"></textarea>` +
    '<div class="composer-actions">' +
    '<button class="cancel">Cancel</button>' +
    '<button class="primary submit">Post</button>' +
    '</div>';
  el.shadow.appendChild(composer);
  // Placed before the first paint, so the card never flashes where it isn't.
  placeCards(el);
  const ta = composer.querySelector('textarea') as HTMLTextAreaElement;
  ta.value = carried;
  // Synchronously, inside the handler that opened it: deferred to a timeout
  // this is no longer a user gesture and iOS keeps the keyboard down — the
  // field looks focused and nothing can be typed. `preventScroll`, because
  // the page holds still while you type.
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(carried.length, carried.length);
  // The one exception to holding still: an element the panel would sit on
  // top of cannot be "still on screen", so the page moves by the least that
  // clears it — and not at all if that would push its top off the screen.
  if (quick && target) {
    const r = target.getBoundingClientRect();
    const over = r.bottom - composer.getBoundingClientRect().top + 12;
    if (over > 0 && r.top - over > 8) window.scrollBy(0, over);
  }
  // Cancel is NOT Done. It throws the draft away and hands you back the mode,
  // so the next element is one tap away; where the mode rests in a composer,
  // that is a fresh empty one. Leaving the mode is the banner's Done, and it
  // never sits beside Post.
  composer.querySelector('.cancel')?.addEventListener('click', () => {
    closeComposer(el, composer);
    if (el.feedbackMode && !quick) openDefaultComposer(el);
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
      posted = await el.postNewThread(anchor, text);
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
    // Posted, so nothing is waiting any more: a copy kept when the mode closed
    // mid-post would otherwise come back to be posted twice.
    drafts.delete(key);
    clearHighlight(el);
    el.hoverEl = null;
    if (quick) {
      // The panel goes back to its prompt with a tick, so the next element
      // can be tapped without re-entering anything.
      composer.remove();
      const tick = el.shadow.querySelector('.picker-banner .tick') as HTMLElement | null;
      if (tick) {
        tick.hidden = false;
        setTimeout(() => {
          tick.hidden = true;
        }, SAVED_MS);
      }
    } else {
      // The card you typed in BECOMES the saved comment, where it stood,
      // with its line and a tick — "did that land" is asked about this card,
      // so the answer is on it. It is only a moment: the pin carries the
      // thread after that.
      composer.className = 'saved';
      composer.innerHTML = `<div class="saved-on"><span class="tick">Saved</span>${head}</div><div class="saved-text">${escape(text)}</div>`;
      setTimeout(() => composer.remove(), SAVED_MS);
    }
    // Commenting is a MODE: posting hands you straight back to it, so several
    // comments in a row cost one entry and one exit. Round 3 dropped this at
    // tablet width and the next element was not tappable until the FAB had
    // been pressed twice.
    if (el.feedbackMode && !quick) openDefaultComposer(el);
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
