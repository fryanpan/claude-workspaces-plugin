import { type MicLabels, type WidgetMic, addMic } from '../widget-mic.ts';
import type { FeedbackWidgetEl } from '../widget.ts';
import type { VoiceMode } from './voice-mode.ts';

/**
 * The mic on a mock page, and the fetch of voice feedback on its first tap.
 *
 * A mock page loads the budgeted `widget.iife.js`, and voice feedback is
 * several kilobytes that most visits never use — so none of it is in that
 * bundle. The mock page's own script (`mockup-live.js`, which only a mock the
 * workspace serves ever loads) puts the button in the history button's slot,
 * and the first tap fetches `voice.js` beside it and starts recording.
 *
 * The AudioContext is made HERE, inside the tap, and handed on: Safari starts
 * one only from a gesture, and by the time a fetched script runs, the tap is
 * over.
 */

/** Mic glyph, from the round-4 mock. */
export const MIC_GLYPH =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>';

/** On a mock, the feedback is about the mock. */
export const MOCK_LABELS: MicLabels = {
  comment: 'Type: comment on this mock',
  voice: 'Talk: voice feedback on this mock',
  history: 'Past comments on this mock',
  icon: MIC_GLYPH,
};

/** On anybody else's page, it is about the page. `mic-entry.ts` uses these:
 *  that embed is a guest on a dev server, where "this mock" would be a lie. */
export const EMBED_LABELS: MicLabels = {
  comment: 'Type: comment on this page',
  voice: 'Talk: voice feedback on this page',
  history: 'Past comments on this page',
  icon: MIC_GLYPH,
};

/**
 * Said while the page is still parsing, because that is when it has to be
 * heard.
 *
 * A served mock loads `widget.iife.js` and `mockup-live.js`, and the injector
 * in the first must not fetch a second mic for the mount the second is about
 * to do. Both mounts go through THIS module, and a bundle's module scope runs
 * as the script is evaluated — before DOMContentLoaded, which is when either
 * mount happens and when the injector looks. So a page carrying any bundle
 * that can mount a mic has said so before anything reads it, whatever order
 * the tags are in. `widget-mic-inject.ts` is the reader.
 */
window.cwMic = true;

/** What `voice.js` puts on the window when it has loaded. */
export interface VoiceChunk {
  mountVoiceMode(widget: FeedbackWidgetEl, mic: WidgetMic): VoiceMode;
}

declare global {
  interface Window {
    cwVoice?: VoiceChunk;
  }
}

/** An AudioContext made now, inside the tap, or nothing where there is none. */
export function makeContext(): AudioContext | undefined {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  try {
    const ctx = Ctor ? new Ctor() : undefined;
    void ctx?.resume().catch(() => {});
    return ctx;
  } catch {
    return undefined;
  }
}

function appendScript(src: string): Promise<VoiceChunk> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => (window.cwVoice ? resolve(window.cwVoice) : reject(new Error('voice.js')));
    s.onerror = () => reject(new Error('voice.js'));
    document.head.append(s);
  });
}

/**
 * Inside a served mock's sandboxed frame a `<script src>` goes out without the
 * reader's session cookie (`server/src/mockup-frame.ts`), and behind a sign-in
 * that loads a redirect rather than a script. `fetch` there goes through the
 * page holding the frame, which has the cookie, so the bytes come that way and
 * run from a blob.
 */
function loadChunk(src: string): Promise<VoiceChunk> {
  if (window.cwVoice) return Promise.resolve(window.cwVoice);
  if (window.parent === window) return appendScript(src);
  return fetch(src)
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error('voice.js'))))
    .then((js) => appendScript(URL.createObjectURL(new Blob([js], { type: 'text/javascript' }))));
}

/**
 * Put the mic on the page's widget. `chunkSrc` is `voice.js`'s URL. Returns
 * null on a page whose widget did not render its buttons (a misconfigured
 * embed says so itself).
 */
export function mountVoiceLoader(
  doc: Document,
  chunkSrc: string,
  labels: MicLabels = MOCK_LABELS,
): WidgetMic | null {
  const widget = doc.querySelector('claude-feedback-widget') as FeedbackWidgetEl | null;
  if (!widget?.shadow?.querySelector('.fab')) return null;
  // A mic already up belongs to whoever mounted it, and `addMic` hands that
  // one back — but the first-tap handler below is NOT idempotent, and a
  // second one would open two AudioContexts, two sockets and two live
  // comments for one sentence. The flag above is what normally keeps a page
  // to a single mount; this is the check for the page where both ran anyway.
  const had = widget.shadow.querySelector('.fab-mic') !== null;
  const mic = addMic(widget, labels);
  if (had) return mic;
  const first = (): void => {
    mic.button.removeEventListener('click', first);
    const ctx = makeContext();
    mic.button.classList.add('voice-active');
    loadChunk(chunkSrc).then(
      (chunk) => chunk.mountVoiceMode(widget, mic).toggle(ctx),
      () => {
        mic.button.classList.remove('voice-active');
        mic.readout.textContent = 'Voice feedback could not load. Try again.';
        mic.readout.classList.remove('hidden');
        mic.button.addEventListener('click', first);
        void ctx?.close();
      },
    );
  };
  mic.button.addEventListener('click', first);
  return mic;
}
