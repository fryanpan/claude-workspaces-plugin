/**
 * The guesses a meeting left marked, named to the pass that can settle them.
 *
 * The note-taker is asked to end a note it is unsure of with "(unconfirmed)",
 * and that is right while the meeting is running: a marked guess is worth
 * more to the room than a confident wrong note. What it must not be is the
 * last word. A person reading finished minutes has no way to act on a note
 * that says it might be wrong.
 *
 * WHY THE EARLIER FIX DID NOT HOLD, which is the thing to understand before
 * adding another rule. The remedy shipped in `CLEANUP_DIRECTIVE` as one
 * clause: "FIX what the whole transcript shows to be wrong: … a point marked
 * (unconfirmed) that the rest of the meeting confirms or refutes." Three
 * survived a real 41-minute meeting, and the clause is not why:
 *
 * - IT WAS CONDITIONAL. "that the rest of the meeting confirms or refutes"
 *   excuses every guess the meeting never settles, which is most of them.
 * - IT NAMED NOTHING. The pass had to find the marked bullets itself, in a
 *   section of 192. This is the failure `notes-regroup.ts` already measured
 *   and already answered: a rule that asks the model to do arithmetic over a
 *   doc it is shown in slices holds on 2% to 17% of ticks, and the fix is for
 *   the server to do the counting and name the ids.
 * - AND ON THAT MEETING NO CLEANUP EDIT COULD LAND AT ALL. Every note had
 *   been written outside the meeting's own section, and the gate tested
 *   LOCATION, so it dropped all sixteen edits the pass proposed. No wording
 *   of any clause reaches a doc through a gate that is refusing everything.
 *   That half is fixed elsewhere: `boundByAuthorship` bounds the pass by
 *   whose words change rather than by where a block sits.
 *
 * So this module does the two halves the clause could not: it finds the
 * marked notes in the section and names them by id, and it is read again
 * AFTER the pass so a survivor is counted rather than assumed away.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS DELETE THE MARKER. Stripping
 * "(unconfirmed)" makes a guess read as a fact — the note is unchanged and
 * now claims more than the meeting said — which is the one outcome worse than
 * the marker surviving. The marker leaves when the pass RESOLVES the note,
 * and a survivor is reported so the next failure is visible instead of
 * silent.
 *
 * Pure: an outline in, ids and prompt text out. Nothing here reads a doc or
 * writes one.
 */

import type { prose } from '@claude-workspaces/core';
import { sectionIds } from './notes-cleanup-scope.ts';

/** The marker, exactly as `unconfirmedBullets` in `notes-quality.ts` scores
 *  it, so the prompt and the measurement cannot disagree about what counts. */
const UNCONFIRMED = /\(unconfirmed\)/i;

/** One note still carrying the marker. */
export interface UnconfirmedNote {
  id: string;
  text: string;
}

export interface UnconfirmedScope {
  /** The meeting's own notes heading. */
  headingId: string;
  /** Only this author's notes. A person's own "(unconfirmed)" is theirs to
   *  keep, and the pass may not rewrite it anyway. */
  author?: string | undefined;
  /** Blocks a comment points into. Out of the pass's reach, so naming one
   *  asks for an edit that cannot be made. */
  commented?: ReadonlySet<string>;
}

/** Every marked note inside the meeting's section, in document order. */
export function unconfirmedNotes(
  outline: readonly prose.OutlineEntry[],
  scope: UnconfirmedScope,
): UnconfirmedNote[] {
  const { blocks } = sectionIds(outline, scope.headingId);
  if (blocks.size === 0) return [];
  const out: UnconfirmedNote[] = [];
  for (const entry of outline) {
    if (entry.kind === 'heading') continue;
    if (!blocks.has(entry.id) || entry.id === scope.headingId) continue;
    if (scope.author !== undefined && entry.author !== scope.author) continue;
    if (scope.commented?.has(entry.id) === true) continue;
    if (!UNCONFIRMED.test(entry.text)) continue;
    out.push({ id: entry.id, text: entry.text });
  }
  return out;
}

/**
 * The directive as it reaches the cleanup prompt, or `null` when the meeting
 * left no guesses — which is the ordinary meeting, and the one this must cost
 * nothing.
 *
 * It names ids because the edit it asks for is addressed by id, and because a
 * model asked to find its own marked bullets in a long section does not.
 */
export function unconfirmedDirective(notes: readonly UnconfirmedNote[]): string | null {
  if (notes.length === 0) return null;
  const many = notes.length > 1;
  return [
    `${notes.length} NOTE${many ? 'S' : ''} BELOW ${many ? 'ARE' : 'IS'} STILL MARKED "(unconfirmed)" — SETTLE`,
    `${many ? 'EVERY ONE OF THEM' : 'IT'} IN THIS PASS. You wrote the marker while the meeting was`,
    'running and you could not yet tell; you can now see the whole transcript,',
    'so the reader must not be left holding the guess.',
    '',
    'For each one, replace_block it with ONE of:',
    '- the note as it stands with the marker removed, when the meeting bears',
    '  it out,',
    '- the corrected note with the marker removed, when the meeting says',
    '  otherwise,',
    '- the note rewritten to say what the meeting actually left open — who',
    '  would know, or what was never answered — so it reads as an open',
    '  question rather than as a note that doubts itself.',
    '',
    'Keep every link the note already carried. Do not delete the note.',
    '',
    'The notes still marked:',
    ...notes.map((n) => `    ${n.id} | ${n.text}`),
  ].join('\n');
}
