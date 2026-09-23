/**
 * The entry of `/widget/mic.js` — the microphone an ordinary embed fetches.
 *
 * `widget-mic-inject.ts`, in the budgeted bundle, appends this script at
 * DOMContentLoaded on a page that has a widget and no mic. Everything here is
 * off `check:widget-size` for the reason `mockup-live.js` and `voice.js` are:
 * it runs on a page that asked for it, and never on the bytes every embed
 * loads. `voice-loader.ts` mounts the button and fetches `voice.js` beside
 * this script on the first tap, so a page that never speaks pays for the
 * button and nothing behind it.
 *
 * The labels are the page's, not a mock's: this widget is a guest on somebody
 * else's dev server, and "this mock" would be a lie there.
 */
import { mountEditLoader } from './edit/edit-button.ts';
import { EMBED_LABELS, mountVoiceLoader } from './voice/voice-loader.ts';
import type { FeedbackWidgetEl } from './widget.ts';

/** Put the mic and the pencil on this document's widget. Exported for the test; the call is
 *  below, because a fetched script's job is to run. */
export function mountEmbedMic(doc: Document): void {
  const el = doc.querySelector('claude-feedback-widget') as FeedbackWidgetEl | null;
  if (!el?.opts.serverUrl) return;
  // Spelled rather than taken from `widget-auth.ts`: importing that module
  // here would drag the whole widget into this chunk, which the page already
  // has.
  const base = el.opts.serverUrl.replace(/^ws/, 'http');
  mountVoiceLoader(doc, `${base}/widget/voice.js`, EMBED_LABELS);
  // The pencil, above the mic: the page's words, edited in place and sent to
  // the agent (`edit/edit-button.ts`).
  mountEditLoader(doc, `${base}/widget/edit.js`);
}

mountEmbedMic(document);
