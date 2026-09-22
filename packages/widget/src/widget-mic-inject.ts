import { httpBase } from './widget-auth.ts';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * The few bytes in the budgeted bundle that fetch the microphone.
 *
 * Everything voice feedback needs was already off the budget and reachable —
 * the button and its stylesheet in `widget-mic.ts`, the capture and the socket
 * in `voice.js` — and nothing on an ordinary embed ever asked for any of it.
 * The mic was mounted in exactly two places, both of them ours: `mockup-live.ts`
 * on a mock the workspace serves, and `board-feedback-mic.ts` on the board. A
 * page that drops in the tag and the script tag got a widget with no way to
 * speak, which is the whole of what was missing once the tailnet door opened.
 *
 * So the bundle every embed loads gains this and nothing else: at
 * DOMContentLoaded, append `<script src="<serverUrl>/widget/mic.js">`. The
 * button, its sheet and the loader that fetches `voice.js` on the first tap
 * are all in that chunk, which costs a page nothing until it is asked for.
 *
 * ## Where it must NOT fire
 *
 * Two pages already mount a mic, and a second mount would arm the first tap
 * twice — two AudioContexts, two sockets, two live comments for one sentence.
 *
 * - **A served mock** loads `widget.iife.js` AND `mockup-live.js`, and the
 *   latter mounts the mic itself on DOMContentLoaded. Which of the two runs
 *   first is not fixed, so the guard cannot be "is a mic there yet": it is
 *   `window.cwMic`, set at module scope by `voice/voice-loader.ts` — the
 *   module both mounts go through — which is therefore set while the page is
 *   still parsing, before either mount runs.
 * - **The board** imports `widget.ts` as a module and mounts its own mic
 *   through `board-feedback-mic.ts`. It is excluded by construction rather
 *   than by a check: this module is reached only from `widget-iife.ts`, the
 *   entry of the script tag, and the board loads no script tag. That is also
 *   why `widget.esm.js` pays none of these bytes.
 *
 * `.fab-mic` is checked as well, which catches a page that mounted a mic
 * some third way and costs one `querySelector`.
 */
export function injectMic(doc: Document): boolean {
  if (window.cwMic) return false;
  const el = doc.querySelector('claude-feedback-widget') as FeedbackWidgetEl | null;
  // No `serverUrl` is an embed that never initialised — a missing `doc-id`,
  // which `init` is what complains about. A mic would have nowhere to send a
  // recording anyway.
  if (!el?.opts.serverUrl) return false;
  // `.fab` rather than the element: the buttons are what a mic hangs beside,
  // and a widget that rendered none is the misconfigured embed above.
  if (!el.shadow?.querySelector('.fab') || el.shadow.querySelector('.fab-mic')) return false;
  window.cwMic = true;
  const s = doc.createElement('script');
  s.src = `${httpBase(el)}/widget/mic.js`;
  s.async = true;
  doc.head.append(s);
  return true;
}

/** Run `injectMic` once the page has its widget, now or at DOMContentLoaded. */
export function armMicInjection(doc: Document): void {
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', () => injectMic(doc), { once: true });
  } else {
    injectMic(doc);
  }
}
