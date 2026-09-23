/**
 * A reason the speaker gave this tick, named in the prompt so the note that
 * carries the point carries the reason too.
 *
 * WHY A RULE IN THE INSTRUCTIONS WAS NOT ENOUGH. The shipped instructions say
 * "keep the reason in the same note: X, because Y". Played tick by tick over
 * a synthetic dictation with three "because" claims, the rule alone kept the
 * reason for most of them and dropped it for one on some runs: "keep the
 * costs in one table, because the council only reads the totals" came back
 * as "consolidate costs into one table for council review". The reason is
 * the part a reader cannot rebuild. Naming the sentence on the tick it is
 * spoken is the same move the dictation and regroup directives make.
 *
 * WHEN IT FIRES: a sentence of this tick with "because", "since" (as a
 * cause, after a comma) or "so that". Nothing else.
 */

import { sentencesOf } from './notes-idea-coverage.ts';

const REASON = /\bbecause\b|,\s*since\b|\bso that\b/i;

/** The sentences of this tick that give a reason. */
export function reasonSentences(turns: readonly { text: string }[]): string[] {
  return turns.flatMap((t) => sentencesOf(t.text)).filter((s) => REASON.test(s));
}

/** The directive naming them, or null when this tick gives no reason. */
export function reasonDirective(turns: readonly { text: string }[]): string | null {
  const said = reasonSentences(turns);
  if (said.length === 0) return null;
  return [
    'THIS SPEECH GIVES A REASON. The note for each point below keeps its reason in the',
    'same note ("X, because Y"), in the words of the speaker:',
    ...said.map((s) => `- "${s}"`),
  ].join('\n');
}
