/**
 * Tone cues in a spoken line: `[warm] It shipped. [curious] Want the next one?`
 *
 * Soniox's TTS reads a bracketed English tag as a delivery cue for the words
 * after it, at the start of a line or mid-sentence, and lists `warm` and
 * `curious` among them (https://docs.soniox.com/tts/concepts/emotion-and-tone).
 * An agent writes them into `answer_voice`'s text, and this module is what the
 * rest of the spoken reply uses to keep them working:
 *
 *  - Each point of a reply is its own Soniox stream (`speak-points.ts`), and a
 *    cue colours only the stream it is in. So a cue that is in effect at the
 *    end of one point is written again at the start of the next
 *    (`carryCues`), and a cue that follows a sentence end starts a point of
 *    its own (`splitAtCues`, called from `reply-shape.ts`).
 *  - A cue is never a word: it is not counted against the spoken word cap,
 *    and it is never shown. The page's caption, the chat and the notes get
 *    `withoutCues`.
 *  - A voice that does not document tags gets `withoutCues` too (`tts.ts`):
 *    ElevenLabs documents audio tags for its v3 and v4 models only, and the
 *    spoken reply uses Flash v2.5.
 */

/** One cue: a bracketed run of English words, such as `[warm]` or
 *  `[clears throat]`. A markdown link's `[text](url)` is not one, nor is a
 *  footnote `[1]`. */
const CUE = /\[([A-Za-z][A-Za-z' -]{0,30})\](?!\()/g;

/** The cues that open `text`, as written (`[warm] [calm] `), or ''. */
const LEADING = /^(?:\s*\[[A-Za-z][A-Za-z' -]{0,30}\](?!\())+\s*/;

/** `text` with every cue taken out and the spacing they left closed up.
 *  Text with no cue comes back exactly as it was. */
export function withoutCues(text: string): string {
  if (!text.includes('[') || text.replace(CUE, '') === text) return text;
  return text
    .replace(CUE, ' ')
    .replace(/\s+([.,;:!?…])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The cues `text` opens with, joined by a space, or '' when it opens with words. */
export function leadingCues(text: string): string {
  const m = text.match(LEADING);
  return m ? m[0].trim().replace(/\s+/g, ' ') : '';
}

/**
 * `text` cut where a cue follows a sentence end (`It shipped. [curious] Next?`),
 * so the cue opens a stream of its own. The cut is made after the shaper has
 * chosen what to say: a cue never changes which sentences are said.
 */
export function splitAtCues(text: string): string[] {
  return text
    .split(/(?<=[.?!…])\s+(?=\[[A-Za-z][A-Za-z' -]{0,30}\](?!\())/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The last cue in `text`, which is the one in effect at its end, or ''. */
function lastCue(text: string): string {
  let last = '';
  for (const m of text.matchAll(CUE)) last = m[0];
  return last;
}

/**
 * Each part, said as its own stream, with the cue in effect where the last
 * part ended written at its start, unless it opens with a cue of its own.
 * Parts before the first cue are left as they are.
 */
export function carryCues(parts: readonly string[]): string[] {
  let current = '';
  return parts.map((part) => {
    const said = current && !leadingCues(part) ? `${current} ${part}` : part;
    current = lastCue(said) || current;
    return said;
  });
}
