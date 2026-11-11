/**
 * Whether this page, or a frame on it, is speaking with the browser's speech
 * engine: what the lead chat's mic reads to send silence in place of what it
 * hears (`lead-chat-voice-mic.ts`). Why the frame has to say so, and what it
 * posts, is `@claude-workspaces/core/page-speech`.
 *
 * A message counts only from this window or from the window of a frame on
 * this page; anything else may say it is speaking and is ignored. A frame's
 * "speaking" lapses after `SPEECH_HOLD_MS` with no beat, so a frame removed
 * mid-line does not mute the mic for good. Once every source has stopped, the
 * mic stays quiet `SPEECH_TAIL_MS` longer for the room's echo of the last word.
 */
import {
  type SpeechWatchWindow,
  installSpeechWatch,
  parseSpeechMessage,
} from '@claude-workspaces/core/page-speech';

/** How long the mic stays quiet after the last source stopped speaking. */
export const SPEECH_TAIL_MS = 300;
/** How long a source's "speaking" holds without a beat (it beats every 500 ms). */
export const SPEECH_HOLD_MS = 2_000;

/** Calls `onChange` each time the page starts or stops speaking; returns the
 *  unsubscribe. */
export type PageSpeechWatch = (onChange: (speaking: boolean) => void) => () => void;

export function watchPageSpeech(
  onChange: (speaking: boolean) => void,
  win: Window = window,
): () => void {
  installSpeechWatch(win as unknown as SpeechWatchWindow);
  const held = new Map<MessageEventSource, ReturnType<typeof setTimeout>>();
  let speaking = false;
  let tail: ReturnType<typeof setTimeout> | null = null;

  const update = (): void => {
    if (held.size > 0) {
      if (tail) clearTimeout(tail);
      tail = null;
      if (!speaking) {
        speaking = true;
        onChange(true);
      }
      return;
    }
    if (!speaking || tail) return;
    tail = setTimeout(() => {
      tail = null;
      if (held.size > 0 || !speaking) return;
      speaking = false;
      onChange(false);
    }, SPEECH_TAIL_MS);
  };

  /** This page, or a frame on it. */
  const fromHere = (src: MessageEventSource): boolean => {
    if (src === win) return true;
    for (const f of Array.from(win.document.querySelectorAll('iframe'))) {
      if (f.contentWindow === src) return true;
    }
    return false;
  };

  const onMessage = (ev: MessageEvent): void => {
    const m = parseSpeechMessage(ev.data);
    const src = ev.source;
    if (!m || !src || !fromHere(src)) return;
    const was = held.get(src);
    if (was) clearTimeout(was);
    held.delete(src);
    if (m.on) {
      held.set(
        src,
        setTimeout(() => {
          held.delete(src);
          update();
        }, SPEECH_HOLD_MS),
      );
    }
    update();
  };

  win.addEventListener('message', onMessage);
  return () => {
    win.removeEventListener('message', onMessage);
    for (const t of held.values()) clearTimeout(t);
    held.clear();
    if (tail) clearTimeout(tail);
    tail = null;
  };
}
