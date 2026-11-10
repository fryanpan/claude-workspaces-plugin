/**
 * Whether a speaker who has gone quiet has finished the thought, as one
 * question every caller asks the same way.
 *
 * The word rules in `pause-gate.ts` catch a phrase that stops on "and" or a
 * comma. They cannot catch a whole sentence with more to come ("Saltmarsh is
 * late." and then the reason), a list with one item said, or a question the
 * speaker is about to answer. Those need a reading of meaning, so this asks
 * Haiku, once, on the last few lines of talk. The lead's held meeting line
 * (`lead-chat/lead-line-hold.ts`) asks it only while a line is waiting, so
 * the cost is a few calls per line rather than one per turn.
 *
 * `invitesReply` is the one word rule kept here: a question put to the room
 * ("Any questions?") is a finished thought by definition, and needs no call.
 */
import type { VoiceComplete } from '../voice.ts';

/** The question, as the judge is asked it. Measured on the replay set in
 *  `scripts/lead-hold-replay.ts`; change it there first. */
export const THOUGHT_SYSTEM = [
  'You read the live transcript of a meeting, one line per stretch of speech, oldest first.',
  'It is speech-to-text: punctuation is often missing, and a full stop may stand where the',
  'speaker only paused. Judge from the words, never from the punctuation.',
  'The room has just gone quiet for about a second after the LAST line. Decide whether the',
  'thought is complete as of those last words, so that someone else could speak now without',
  'interrupting. Earlier lines are context only: a pause or filler earlier on that was',
  'followed by more words does not count.',
  'UNFINISHED only when the last words themselves show more is coming: they stop',
  'mid-sentence, on a filler ("um", "uh") or while searching for a word; a list was',
  'announced ("three things") and its last item has not been said; the last line is a',
  'question the speaker is about to answer ("Why does that matter?"); the last line is a',
  'short opening that plainly sets up an explanation not yet given ("Saltmarsh is late.");',
  'or the last line is only a brief acknowledgement ("mm-hm", "right") from someone other',
  'than the person speaking before it.',
  'FINISHED otherwise: a complete statement, the last item of a list, an answer, a',
  'decision, a speaker wrapping up or trailing off after a wrap-up ("that is about it, I',
  'suppose, but"), or a question put to the room.',
  'Answer with one word: FINISHED or UNFINISHED.',
].join('\n');

/** The lines the judge reads, oldest first, one per turn. */
export function thoughtPrompt(recent: string): string {
  return `Transcript, oldest first:\n${recent}\n\nHas the last speaker finished?`;
}

/** The judge's answer, or null when it said neither word. */
export function readThought(answer: string): boolean | null {
  const a = answer.trim().toUpperCase();
  if (a.startsWith('UNFINISHED')) return false;
  if (a.startsWith('FINISHED')) return true;
  return null;
}

/** "Any questions?", "What do people think?": the speaker handed the room
 *  the floor. Only a question counts, so a statement about questions does
 *  not. */
const INVITE =
  /\b(?:any(?:one|body)?\s+(?:questions?|thoughts?|comments?|objections?|else)|anything\s+(?:to\s+add|else|from\s+you)|what\s+do\s+(?:you|people|we|folks|others|you\s+all)\s+think|what\s+does\s+everyone\s+think|thoughts|over\s+to\s+you|lead\b)/i;

/** The same, said last with no question mark, as a transcriber may write it. */
const INVITE_END = new RegExp(`(?:${INVITE.source})[\\s.!]*$`, 'i');

export function invitesReply(text: string): boolean {
  const t = text.trim();
  if (!/\?$/.test(t)) return INVITE_END.test(t) && !/\blead\W*$/i.test(t);
  // The last sentence only: an invitation earlier in a turn that went on is
  // not the floor being handed over.
  const last = t.split(/(?<=[.!?])\s+/).pop() ?? t;
  return INVITE.test(last);
}

/** Asks the judge; `done` is called once, unless the returned cancel runs
 *  first. */
export type ThoughtJudge = (recent: string, done: (finished: boolean) => void) => () => void;

/**
 * The judge over a completer (`haikuVoiceComplete`). A failed call, or an
 * answer that is neither word, reads as UNFINISHED: the line then waits for
 * the hold's longer silence instead of cutting in on a guess.
 */
export function thoughtJudge(complete: VoiceComplete): ThoughtJudge {
  return (recent, done) => {
    let live = true;
    complete({ system: THOUGHT_SYSTEM, user: thoughtPrompt(recent) }).then(
      (answer) => {
        if (live) done(readThought(answer) === true);
      },
      () => {
        if (live) done(false);
      },
    );
    return () => {
      live = false;
    };
  };
}
