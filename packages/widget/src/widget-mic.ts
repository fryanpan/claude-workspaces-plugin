import type { FeedbackWidgetEl } from './widget.ts';

/**
 * What a refused write says — the sentence the typed composer has always put
 * in its own note, spelled again here for the host that must say it about a
 * SPOKEN comment the workspace would not take.
 *
 * Spelled, not imported. `widget-auth.ts` is in the budgeted bundle, and
 * turning its inline literal into an exported name costs every mock page
 * bytes for a string only a page with a microphone ever reads. The copy is
 * safe because it is not trusted: a case in `widget-auth.test.ts` opens the
 * real composer against a workspace that wants a signature and asserts the
 * note it renders begins with this, so the two cannot drift apart quietly.
 */
export const SIGN_IN_NOTE = 'Sign in to post. Your draft is kept.';

/**
 * A microphone on the widget, for a host that has one to hand it.
 *
 * The widget has no voice capture of its own and gets none here. The board
 * already has one — `createVoiceCapture` in the app, hold-to-talk with its
 * origin gate and its error wording — so this module only makes the BUTTON
 * and the line the capture writes into, and the host wires its own capture
 * to them. One capture, not a second one grown inside the widget.
 *
 * Its own entry (`@claude-workspaces/widget/mic`), never imported by
 * `widget.ts`. The one page with a microphone to offer is the board, which
 * imports the widget into its own bundle; every mock page loads the budgeted
 * `widget.iife.js` instead, and none of the bytes below reach it.
 *
 * The mic takes the slot the thread list stood in, above the FAB, and the list
 * steps up one (`.side`). The owner's words for this embed (2026-09-11):
 * "Replace the feedback history button with a button that initiates voice
 * feedback" — and both buttons should say, on hover, whose feedback they
 * take. `labels` carries that wording, so the host that knows what the
 * feedback is about is the one that says it.
 */

export interface MicLabels {
  /** The FAB's hover label. */
  comment: string;
  /** The mic's hover label. */
  voice: string;
  /** The thread list's hover label. */
  history: string;
  /** The mic glyph — markup, from the host's own icon set. */
  icon: string;
}

export interface WidgetMic {
  button: HTMLButtonElement;
  /** Where the capture writes what it heard and the answer. Toggles `.hidden`. */
  readout: HTMLElement;
}

/**
 * Minified by hand: the widget's build minifies `styles*.ts` only, and this
 * sheet ships in the host's bundle rather than the widget's, so there is no
 * budget pressing on it — but it is still one rule a line.
 */
const MIC_CSS = [
  '.side{bottom:calc(var(--cw-vv-bottom) + var(--cw-dock-h) + max(126px,calc(env(safe-area-inset-bottom) + 126px)))}',
  // The phone face folds the floating buttons away under its bottom panel,
  // and the mic wears .fab-list for its look and its slot, so it folded with
  // the thread list — leaving the one width where speaking beats typing with
  // no mic in the mode at all. The mic is the exception, and it says so HERE
  // rather than in the widget's own sheet: the widget ships to every mock
  // page under a gzip budget, and none of those pages has a mic to except.
  // Two classes beats the fold rule's one class plus its :has() on equal
  // terms, and this sheet is appended after the widget's, so it wins the tie.
  // It needs nothing to move for it: the slot starts 74px up and the panel is
  // about 64px tall in its short form. The tall form is what --cw-quick-h is
  // for, below.
  '.fab-list.fab-mic{display:flex}',
  '.fab-mic svg{width:20px;height:20px}',
  '.fab-mic.voice-active{background:#d1242f;border-color:#d1242f;color:#fff}',
  '.fab-mic.voice-unavailable{color:#8c959f}',
  // Said on hover, at once, rather than in a `title` that takes a second to
  // appear. Beside the button, toward the page.
  //
  // One line where there is room, and WRAPPED where there is not. The host's
  // words are the host's — the board's run to seventy-odd characters, because
  // each one says whose feedback the button takes — and one unbreakable line
  // of those ran off the left edge of a 430-wide screen by 43px for the mic
  // and 92px for the list. The bound is the screen: the buttons sit ~76px in
  // from the right, so a label no wider than `100vw - 88px` keeps its left
  // edge on screen at every width, and nothing narrows a label that already
  // fits.
  //
  // Three declarations do that one job, and dropping any of them loses it:
  //
  // - `width:max-content`, because this box is positioned against the BUTTON,
  //   44px wide, so shrink-to-fit would size it from 44px minus the 56px
  //   offset. That is why the old rule needed `nowrap` to be readable at all,
  //   and why a max-width alone wrapped every label to its longest word.
  // - `box-sizing:border-box`, because the sheet's own `*` rule does not
  //   reach a pseudo-element: without it the cap bounds the TEXT and the 20px
  //   of side padding hangs off the end of it, which is 20px back off-screen.
  // - the cap itself.
  '[data-tip]:hover::after{content:attr(data-tip);position:absolute;right:56px;top:50%;transform:translateY(-50%);box-sizing:border-box;width:max-content;max-width:calc(100vw - 88px);background:#1b1f23;color:#fff;font-size:12px;line-height:1.3;padding:6px 10px;border-radius:6px;pointer-events:none}',
  '.readout{position:fixed;right:78px;bottom:calc(var(--cw-vv-bottom) + var(--cw-dock-h) + max(74px,calc(env(safe-area-inset-bottom) + 74px)));max-width:min(320px,calc(100vw - 110px));background:#1b1f23;color:#fff;border-radius:8px;padding:8px 12px;font-size:13px;line-height:1.4;z-index:2147483647}',
  // Both of them above the phone face's bottom panel, whose height
  // `placeCards` measures into --cw-quick-h every frame. AFTER the two rules
  // that set their slots, because it is the same property at the same
  // specificity and the last one is the one that counts.
  //
  // `max` rather than a sum, so neither drifts upward on a page with no panel
  // at all: with nothing docked the 74px slot still wins, and a panel only
  // ever pushes them further up.
  '.fab-mic,.readout{bottom:calc(var(--cw-vv-bottom) + var(--cw-dock-h) + max(74px,calc(env(safe-area-inset-bottom) + 74px),calc(var(--cw-quick-h, 0px) + 12px)))}',
  // The capture's own states. `createVoiceCapture` puts a spinner in the
  // readout while a post is in flight and takes the long form for a
  // paragraph-length answer; the app's rules for both are in
  // `workspaces-app/src/styles.css` and no sheet out there crosses a shadow
  // boundary, so the same two states are spelled again here. Values, not the
  // app's custom properties, for the same reason.
  '.readout.voice-indicator--busy{display:flex;align-items:center;gap:8px}',
  '.readout.voice-indicator--long{white-space:normal;max-height:min(40vh,320px);overflow-y:auto;-webkit-overflow-scrolling:touch}',
  '.voice-spinner{flex:none;width:14px;height:14px;border:2px solid #d0d7de;border-top-color:#2e7dd7;border-radius:50%;animation:cw-voice-spin .8s linear infinite}',
  '@keyframes cw-voice-spin{to{transform:rotate(360deg)}}',
  // Asking for less motion keeps the mark and drops the rotation.
  '@media (prefers-reduced-motion:reduce){.voice-spinner{animation:none;opacity:.8}}',
  // Last, so a hidden readout stays hidden however the capture has classed it.
  '.readout.hidden{display:none}',
].join('');

/**
 * How tall the phone face's bottom panel is right now, published as
 * `--cw-quick-h` so the mic and its readout can say in CSS that they stay
 * above it.
 *
 * The panel's height is its contents': the mode's prompt is one row, the
 * composer is a row that grows to four lines as you type, and a workspace
 * that wants a signature adds a line of news and a button under that. A fixed
 * 74px slot cleared the short form by ten pixels and disappeared under the
 * tall one — painted, on screen, and under the reviewer's thumb at the same
 * moment as the field they are typing in.
 *
 * Every `.quick` in the shadow root, not the first: the prompt stays in the
 * DOM while the composer stands in front of it, and a hidden element measures
 * zero, so the tallest is the one on screen.
 *
 * It lives HERE, on a frame loop of its own, for two reasons that agree. The
 * widget's own bundle is on a byte budget and this module is not in it — a
 * mock page loads the budgeted `widget.iife.js` and has no mic — and a page
 * with no mic has nothing this measurement would move, so a hook in the
 * widget's loop would be bytes every mock page pays for a button it does not
 * have. The loop stops with the button: a mic off the page schedules no
 * further frame.
 */
function reserveQuickPanel(el: FeedbackWidgetEl): void {
  let h = 0;
  for (const p of el.shadow.querySelectorAll('.quick')) {
    h = Math.max(h, Math.round(p.getBoundingClientRect().height));
  }
  const next = `${h}px`;
  // Written only when it moved: this runs every frame.
  if (el.style.getPropertyValue('--cw-quick-h') !== next) {
    el.style.setProperty('--cw-quick-h', next);
  }
}

/**
 * Make the widget's one sign-in retry slot hold everything put in it, instead
 * of only the last thing.
 *
 * `retryAfterSignIn` is a single field, and until a host could park something
 * in it that was safe: the typed composer was the only writer and it re-armed
 * on each refusal. A mic makes it shared. Two people are then told "your
 * draft is kept" — the one who spoke and the one who typed — and a plain
 * assignment keeps whichever was written last and silently drops the other,
 * which is the sentence-losing bug the mic exists to end, rebuilt one layer
 * up.
 *
 * Done as a property on the instance rather than by asking both writers to
 * chain, for the same reason the sentence above is spelled twice: the typed
 * composer lives in the budgeted bundle, and a page with no mic has no
 * sharing to arrange. Assignment appends, reading hands back one function
 * that runs the queue oldest first, and `= null` — which the widget does
 * immediately after running it — empties the queue. So the widget's own two
 * lines work unchanged and know nothing about this.
 */
function shareRetrySlot(el: FeedbackWidgetEl): void {
  let queue: Array<() => void> = [];
  Object.defineProperty(el, 'retryAfterSignIn', {
    configurable: true,
    get: () =>
      queue.length === 0
        ? null
        : () => {
            // Taken before running: a retry refused a second time re-arms the
            // slot, and that belongs to the next sign-in, not this pass.
            const holding = queue;
            queue = [];
            for (const run of holding) run();
          },
    set: (next: (() => void) | null) => {
      if (next === null) queue = [];
      else queue.push(next);
    },
  });
}

/**
 * Put the mic on this widget. Idempotent: a second call hands back the
 * first mic rather than a second one, since a capture is wired to exactly one.
 */
export function addMic(el: FeedbackWidgetEl, labels: MicLabels): WidgetMic {
  const s = el.shadow;
  const had = s.querySelector('.fab-mic') as HTMLButtonElement | null;
  if (had) return { button: had, readout: s.querySelector('.readout') as HTMLElement };
  const style = document.createElement('style');
  style.textContent = MIC_CSS;
  const button = document.createElement('button');
  // `.fab-list` for the look and the place, and so everything that steps
  // around the widget's own buttons — the comment card, the phone panel —
  // steps around this one too.
  button.className = 'fab-list fab-mic';
  button.innerHTML = labels.icon;
  const readout = document.createElement('div');
  readout.className = 'readout hidden';
  readout.setAttribute('aria-live', 'polite');
  const list = s.querySelector('.fab-list');
  list?.classList.add('side');
  const tips: Array<[Element | null, string]> = [
    [s.querySelector('.fab'), labels.comment],
    [button, labels.voice],
    [list, labels.history],
  ];
  for (const [b, tip] of tips) {
    if (!(b instanceof HTMLElement)) continue;
    // The hover label replaces the title, or both would show.
    b.removeAttribute('title');
    b.dataset.tip = tip;
    b.setAttribute('aria-label', tip);
  }
  s.append(style, button, readout);
  shareRetrySlot(el);
  const tick = (): void => {
    if (!button.isConnected) return;
    reserveQuickPanel(el);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { button, readout };
}
