/**
 * What of the router's answer is said, and what is only written.
 *
 * The plan's first rule is "say less, write more": the voice gives the
 * headline and the question, and the page carries the rest. The router
 * (`voice.ts`) answers in prose built for reading — "Heard: …", then the
 * answer, often several sentences — so this cuts it in two:
 *
 *  - a QUESTION is said on its own. "Did you mean A or B? Say first or
 *    second…" speaks the first sentence and writes the second, so a
 *    follow-up is one spoken question and then silence.
 *  - anything else speaks its first two sentences. When a status brief has a
 *    "Waiting on you" sentence, that one is the second: what changed, then
 *    what needs you.
 *
 * `SPOKEN_MAX_WORDS` is the hard cap under both rules, cut on a word
 * boundary, because a runaway sentence read aloud costs far more than one
 * left on the screen.
 *
 * The spoken part is also kept sentence by sentence (`says`), because each
 * sentence is a point that may carry a note (`notes.ts`), and its audio is
 * made separately so the note can land as that point starts.
 */
import { SPOKEN_MAX_WORDS } from '@claude-workspaces/core/spoken-reply';
import { carryCues, splitAtCues, withoutCues } from './cues.ts';

export interface ShapedReply {
  spoken: string;
  /** `spoken`, sentence by sentence: what each point says. */
  says: string[];
  detail: string[];
  asking: boolean;
}

/**
 * The wake phrase, off the front: "Claude, give me a status update" is the
 * request "give me a status update". The router's own patterns are whole-
 * utterance, so without this the most natural way to ask would miss them.
 */
export function stripWake(transcript: string): string {
  const stripped = transcript
    .trim()
    .replace(/^(?:(?:hey|hi|ok|okay|so)[\s,]+)?claude\b[\s,.!:;-]*/i, '')
    .trim();
  return stripped || transcript.trim();
}

/** The router's `Heard: "…".` prefix is for a reader checking the mic, and
 *  the page shows what was heard already. Never spoken. */
function withoutHeard(ack: string): string {
  return ack.replace(/^\s*Heard: ".*?"\.\s*/s, '').trim();
}

/** Sentences, split after `.`, `?` or `!` where the next one starts. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!…])\s+(?=[A-Z0-9“"‘'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** A point's tokens: a whole tone cue (`[clears throat]`) or a word. */
const TOKEN = /\[[^\]]*\]|\S+/g;

/** The word cap across the points in order: a point past it is cut on a word
 *  boundary, and a point with no words left is dropped. A tone cue is not a
 *  word: it is never said, so it never counts. */
function capSays(parts: readonly string[]): string[] {
  const out: string[] = [];
  let left = SPOKEN_MAX_WORDS;
  for (const part of parts) {
    if (left <= 0) break;
    const tokens = part.match(TOKEN) ?? [];
    const kept: string[] = [];
    let words = 0;
    for (const t of tokens) {
      const cue = t.startsWith('[') && t.endsWith(']');
      if (!cue && words === left) break;
      kept.push(t);
      if (!cue) words++;
    }
    const count = tokens.filter((t) => !(t.startsWith('[') && t.endsWith(']'))).length;
    out.push(count <= left ? part : `${kept.join(' ')}…`);
    left -= count;
  }
  return out;
}

function shaped(parts: readonly string[], detail: string[], asking: boolean): ShapedReply {
  const says = capSays(carryCues(parts.flatMap(splitAtCues)));
  return { spoken: says.join(' '), says, detail: detail.map(withoutCues), asking };
}

export function shapeReply(ack: string): ShapedReply {
  const all = sentences(withoutHeard(ack));
  if (all.length === 0) return { spoken: '', says: [], detail: [], asking: false };
  const q = all.findIndex((s) => s.endsWith('?'));
  if (q >= 0) {
    return shaped(
      [all[q] ?? ''],
      all.filter((_, i) => i !== q),
      true,
    );
  }
  const first = all[0] ?? '';
  const waiting = all.findIndex((s, i) => i > 0 && /^Waiting on you\b/.test(s));
  const second = waiting > 0 ? waiting : all.length > 1 ? 1 : -1;
  const spokenParts = second > 0 ? [first, all[second] ?? ''] : [first];
  return shaped(
    spokenParts,
    all.filter((_, i) => i !== 0 && i !== second),
    false,
  );
}
