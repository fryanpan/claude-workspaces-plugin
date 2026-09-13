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

function loadChunk(src: string): Promise<VoiceChunk> {
  if (window.cwVoice) return Promise.resolve(window.cwVoice);
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
  const mic = addMic(widget, labels);
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
