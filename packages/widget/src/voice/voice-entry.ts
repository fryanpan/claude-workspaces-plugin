/**
 * The entry of `voice.js` — voice feedback, fetched by a mock page on the
 * mic's first tap (`voice-loader.ts`). It hands its one function to the page
 * on `window.cwVoice` rather than exporting it, because an IIFE has nowhere
 * else to put it.
 */
import { mountVoiceMode } from './voice-mode.ts';

window.cwVoice = { mountVoiceMode };
