/**
 * The speech just before a tick's new speech, handed to the note-taker as
 * context it must not note again.
 *
 * WHY. A tick carries only the words since the last one, and the cadence
 * ceiling cuts a long answer into several of them. Read alone, the third
 * slice of a status round-up is a list of fragments with no subject: "which
 * is done. And then the sync is still pending." The composer had to guess
 * what was done, and replays of four recorded meetings showed it guessing
 * wrong — a finished item noted as in progress, a point credited to whoever
 * spoke last, the second half of an answer noted as a new topic. The words
 * that resolve all three were said seconds earlier and were already in the
 * notes, so the composer was never shown them.
 *
 * WHAT IT IS NOT. It is not a carry: nothing here is owed a note, and the
 * prompt says so in as many words. It is the previous tick's speech, cut
 * from its END to a fixed number of characters, because the words nearest
 * the new speech are the ones that resolve it, and a bound keeps the prompt
 * from growing with the length of the turn.
 */

/** The most characters of earlier speech a tick is shown. About three
 *  sentences: enough to carry a subject across a ceiling cut, and small
 *  beside the outline the prompt already sends. */
export const RECENT_SPEECH_CHARS = 600;

/**
 * The tail of `prior` that is not already part of `current`, at most `max`
 * characters, oldest first. A turn cut to fit is cut from its start and
 * marked with an ellipsis, so what reaches the composer is the end of what
 * was said.
 *
 * A turn in `current` with the same number AND the same words is left out:
 * a failed compose carries its own turns into the next tick, and showing the
 * same sentence as both context and new speech would tell the model it was
 * said twice.
 */
export function recentSpeech<T extends { turn: number; text: string }>(
  prior: readonly T[],
  current: readonly T[],
  max: number = RECENT_SPEECH_CHARS,
): T[] {
  const now = new Set(current.map((t) => `${t.turn}|${t.text}`));
  const out: T[] = [];
  let room = max;
  for (let i = prior.length - 1; i >= 0 && room > 0; i--) {
    const t = prior[i] as T;
    if (now.has(`${t.turn}|${t.text}`)) continue;
    const text = t.text.trim();
    if (text.length === 0) continue;
    if (text.length <= room) {
      out.unshift(t);
      room -= text.length;
      continue;
    }
    // Cut at a word boundary inside the last `room` characters.
    const tail = text.slice(text.length - room);
    const space = tail.indexOf(' ');
    const words = space >= 0 ? tail.slice(space + 1) : tail;
    if (words.length > 0) out.unshift({ ...t, text: `…${words}` });
    break;
  }
  return out;
}

/** The prompt block for {@link recentSpeech}. `prefix` is the builder's own
 *  speaker rendering, so this module knows nothing about how a voice is
 *  addressed. Empty when there is nothing to show. */
export function recentBlock<T extends { text: string }>(
  recent: readonly T[],
  prefix: (turn: T) => string,
): string {
  if (recent.length === 0) return '';
  return [
    'Speech just before the new speech. It is already in the notes. Read it',
    'only to understand what the new speech is about: who is speaking, which',
    'item a list continues, what "it" or "that" names. Write no note for it.',
    ...recent.map((t) => `- ${prefix(t)}${t.text}`),
  ].join('\n');
}
