/**
 * Whether a page, or a sandboxed frame inside it, is speaking with the
 * browser's own speech engine (`speechSynthesis`), so the lead chat's mic can
 * stop sending what it hears while it does.
 *
 * On 9 Nov a board app in a sandboxed frame (a turn-by-turn navigator) spoke
 * its turns with `speechSynthesis` while the lead chat was listening, and the
 * mic sent the app's speech up as the owner's requests. The echo canceller
 * does not remove it: Chrome and Safari cancel only what the page plays
 * through its own audio output, and `speechSynthesis` plays through the
 * operating system's speech engine instead. The page holding the frame cannot
 * read the frame's `speechSynthesis` either, because the frame's origin is
 * opaque or another host's. So the frame says it: the server writes
 * `installSpeechWatch` into every mock, app and doc-file frame it serves
 * (`SPEECH_WATCH_SCRIPT`), and it posts `{cw: 'speaking', on}` to the page
 * holding it. The lead chat runs the same function on its own page, which
 * posts to itself (`lead-chat/page-speech.ts` in the app reads both).
 *
 * The message carries one boolean and nothing of the page, so it is posted to
 * any origin. While the engine speaks it is posted again every
 * `SPEECH_BEAT_MS`, so a frame removed mid-line cannot leave the mic muted.
 */

/** The message a speaking page posts. */
export interface SpeechMessage {
  cw: 'speaking';
  on: boolean;
}

/** How often a speaking page says so again. Written as a literal inside
 *  `installSpeechWatch`, which must carry nothing from this module. */
export const SPEECH_BEAT_MS = 500;

/** A message a page posted about its speech, or null for any other. */
export function parseSpeechMessage(data: unknown): SpeechMessage | null {
  const m = data as { cw?: unknown; on?: unknown } | null;
  if (!m || typeof m !== 'object' || m.cw !== 'speaking' || typeof m.on !== 'boolean') return null;
  return { cw: 'speaking', on: m.on };
}

/** The parts of a window `installSpeechWatch` touches. */
export interface SpeechWatchWindow {
  parent: unknown;
  speechSynthesis?: { speaking: boolean; pending: boolean };
  SpeechSynthesis?: { prototype: object };
  postMessage(message: unknown, targetOrigin: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/**
 * Wrap `SpeechSynthesis.prototype.speak` and `cancel` so the page says when
 * its engine starts and stops. A frame posts to its parent; a page at the top
 * posts to itself. Installed once per window; a second call does nothing.
 *
 * SELF-CONTAINED: the server writes this function's source into frames
 * (`SPEECH_WATCH_SCRIPT`), so it may name nothing outside itself.
 */
export function installSpeechWatch(w: SpeechWatchWindow): void {
  const engine = w.speechSynthesis;
  const proto = w.SpeechSynthesis?.prototype as
    | {
        speak?: (this: unknown, u: unknown) => unknown;
        cancel?: (this: unknown) => unknown;
        __cwSpeechWatch?: boolean;
      }
    | undefined;
  if (!engine || !proto || typeof proto.speak !== 'function' || proto.__cwSpeechWatch) return;
  proto.__cwSpeechWatch = true;
  const target = (w.parent && w.parent !== w ? w.parent : w) as SpeechWatchWindow;
  const speak = proto.speak;
  const cancel = proto.cancel;
  let on = false;
  let timer: unknown = null;
  const say = (v: boolean): void => {
    on = v;
    try {
      target.postMessage({ cw: 'speaking', on: v }, '*');
    } catch {}
  };
  // While the engine speaks, say so every beat; once it stops, say that once.
  const check = (): void => {
    timer = null;
    const now = engine.speaking || engine.pending;
    if (now) {
      say(true);
      timer = w.setTimeout(check, 500);
    } else if (on) say(false);
  };
  const soon = (): void => {
    if (timer !== null) w.clearTimeout(timer);
    timer = w.setTimeout(check, 50);
  };
  proto.speak = function (this: unknown, u: unknown) {
    // Said before the engine is handed the line, so the mic is quiet before
    // the first word plays.
    say(true);
    const ev = u as { addEventListener?: (t: string, fn: () => void) => void } | null;
    try {
      ev?.addEventListener?.('end', soon);
      ev?.addEventListener?.('error', soon);
    } catch {}
    const r = speak.call(this, u);
    soon();
    return r;
  };
  if (typeof cancel === 'function') {
    proto.cancel = function (this: unknown) {
      const r = cancel.call(this);
      soon();
      return r;
    };
  }
}

/** `installSpeechWatch` as a script a served frame runs first. */
export const SPEECH_WATCH_SCRIPT = `(${installSpeechWatch.toString()})(window);`;
