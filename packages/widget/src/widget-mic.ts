import type { FeedbackWidgetEl } from './widget.ts';

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
  '.fab-mic svg{width:20px;height:20px}',
  '.fab-mic.voice-active{background:#d1242f;border-color:#d1242f;color:#fff}',
  '.fab-mic.voice-unavailable{color:#8c959f}',
  // Said on hover, at once, rather than in a `title` that takes a second to
  // appear. Beside the button, toward the page.
  '[data-tip]:hover::after{content:attr(data-tip);position:absolute;right:56px;top:50%;transform:translateY(-50%);white-space:nowrap;background:#1b1f23;color:#fff;font-size:12px;line-height:1.3;padding:6px 10px;border-radius:6px;pointer-events:none}',
  '.readout{position:fixed;right:78px;bottom:calc(var(--cw-vv-bottom) + var(--cw-dock-h) + max(74px,calc(env(safe-area-inset-bottom) + 74px)));max-width:min(320px,calc(100vw - 110px));background:#1b1f23;color:#fff;border-radius:8px;padding:8px 12px;font-size:13px;line-height:1.4;z-index:2147483647}',
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
  return { button, readout };
}
