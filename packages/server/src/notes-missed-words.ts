/**
 * Which words of a retried line the notes still do not carry.
 *
 * WHY THE RETRY NEEDED THIS. The idea ledger puts a line nothing noted back
 * into the next tick's prompt, and the block that carries it lets the
 * note-taker leave one out if the notes already say it in other words. On a
 * measured rerun of a twenty-minute synthetic meeting that escape swallowed
 * almost every retry, and it did so for a reason the sentence could not see:
 * the misses are nearly all "X because Y" lines whose X reached a note and
 * whose Y did not. "Put a reminder on it for the twentieth, because a
 * contract sitting unsigned in an inbox is the same as no contract" came back
 * as "Reminder: follow up on contract signature by the twentieth", the retry
 * read the point as carried, and the reason was counted lost. Twenty-six of
 * the thirty-one misses across four runs had that shape.
 *
 * So the prompt stops asking the note-taker to judge what is carried. The
 * server already knows, word by word — the ledger's own overlap test is what
 * decided to retry the line at all — and this is that knowledge rendered for
 * a reader: the words of the line whose stems are in no note.
 *
 * ONLY WHEN THE LINE IS PART-CARRIED, and that is the whole operating point.
 * A line the notes carry entirely is not retried. A line the notes touch
 * nowhere is missing as a whole, which the retry block already says in
 * words — listing every content word of it would be the sentence again, one
 * word at a time, and it would be the common case on a quiet meeting. The
 * list is worth its tokens exactly when some of the line landed and some did
 * not, because that is the case the note-taker gets wrong.
 *
 * THE WORDS COME BACK AS THEY WERE SAID. The comparison runs on stems, so
 * "estimates" in the speech matches "estimate" in a note; printing the stem
 * would put "estimat" in a prompt. Each word is listed once, in the order the
 * line said it.
 */

import { contentWords, stem } from '@claude-workspaces/core';

/** The most words one line contributes, so a long aside cannot crowd out the
 *  speech the tick is actually about. The lines this fires on are short by
 *  construction — the carried half is what is missing from the list. */
const MAX_WORDS = 8;

/**
 * The words of `line` that no note carries, or none when the notes carry all
 * of it or none of it. See the module header for why both ends answer empty.
 */
export function wordsStillMissing(line: string, notes: string): string[] {
  const noted = new Set(contentWords(notes));
  const wanted = contentWords(line);
  if (wanted.length === 0) return [];
  const absent = new Set(wanted.filter((w) => !noted.has(w)));
  // Carried whole, or touched nowhere: nothing this list can add.
  if (absent.size === 0 || absent.size === wanted.length) return [];
  const out: string[] = [];
  const said = new Set<string>();
  for (const raw of line.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const s = stem(raw.toLowerCase());
    if (!absent.has(s) || said.has(s)) continue;
    said.add(s);
    out.push(raw);
    if (out.length === MAX_WORDS) break;
  }
  return out;
}

/**
 * The retry block of a tick's prompt: the lines the ledger put back, each one
 * followed by the words of it no note carries.
 *
 * IT LIVES HERE RATHER THAN IN `notes-prompt-build.ts` because it is the same
 * subject as the function above it — what a retry is still owed — and because
 * the builder was at the 500-line bar. `prefix` is the builder's own speaker
 * rendering, passed in so this module knows nothing about how a turn is
 * addressed.
 */
export function missedBlock<T extends { text: string }>(
  missed: readonly T[],
  notes: string,
  prefix: (turn: T) => string,
): string {
  return [
    'SAID EARLIER AND STILL IN NO NOTE. Each of these went past without',
    'producing anything. Read them again with the notes above in front of',
    'you: write the note each one should have produced, under the heading',
    'it belongs to. Where a line gives a reason, a cause or a trade-off for',
    'a point the notes already make, the reason is the note to write — it',
    'is an idea, not packaging. Leave one out only if it is a greeting or a',
    'false start. A bracket after a line names the words of it that are in',
    'no note yet. This is their last offer; nothing asks again.',
    ...missed.map((t) => {
      const absent = wordsStillMissing(t.text, notes);
      return `- ${prefix(t)}${t.text}${absent.length > 0 ? ` [no note has: ${absent.join(', ')}]` : ''}`;
    }),
  ].join('\n');
}
