/**
 * The words a tidy-up pass adds to the ordinary note-taking rules, and the
 * line that introduces its transcript.
 *
 * SPLIT OUT OF `notes-cleanup-pass.ts` because a prompt is not a pass. That
 * module decides what happens to an edit list once it comes back — the gate,
 * the dedupe, the write, the tidy — and none of that changes when a clause
 * here is reworded. This file holds only text, exports no function and reads
 * nothing; `packages/server/scripts/notes-cleanup-check.ts` is what says
 * whether a wording holds, and it is the only thing that should move when one
 * changes.
 */

/**
 * The instruction block a cleanup adds to the ordinary note-taking rules.
 *
 * It is an ADDITION and not a replacement, because criterion two of the task
 * is that the pass follows the same rules as regular note-taking and simply
 * does them better. The system prompt is therefore the operator's own
 * instructions, unchanged; everything below is about what makes this read
 * different from a tick — the whole meeting is in front of it, and the notes
 * it is reading are finished work somebody has already seen.
 *
 * THE RESTRAINT CLAUSES ARE SAID THREE WAYS ON PURPOSE — as the job ("make
 * these notes better, not write them again"), as the bar ("a note that
 * already says what was said is FINISHED"), and as the permitted answer ("an
 * empty list is a success"). A single polite request to be conservative reads
 * as a hedge on an instruction to improve; the measurement in
 * `packages/server/scripts/notes-cleanup-check.ts` is what says whether the wording holds.
 *
 * AND ONE CLAUSE PULLS THE OTHER WAY ON PURPOSE. A person's line may be
 * argued with, as a suggestion. Said as a flat prohibition — which is how
 * this read until 2026-09-10 — the model proposed nothing at all on their
 * lines, so the suggestion path underneath it never fired and the feature
 * Bryan asked for did not exist. The restraint that matters is on their
 * WORDS, and the doc enforces that whatever the prompt says.
 */
export const CLEANUP_DIRECTIVE = [
  'FINAL PASS OVER THE WHOLE MEETING. The recording has stopped and a person',
  'asked for one more read of these notes. The transcript below is the ENTIRE',
  'meeting, not the last minute of it, and the notes are what you wrote while',
  'it was running.',
  '',
  'Your job is to make these notes BETTER, not to write them again.',
  '',
  '- CHANGE AS LITTLE AS POSSIBLE. A note that already says what was said, in',
  "  a reader's own words, is FINISHED — leave it exactly as it is, word for",
  '  word. People have already read these notes and commented on them, and a',
  '  rewrite that only moves words around destroys that. If the notes are',
  '  already good, answer with an empty list. That is a success, not a',
  '  failure.',
  '- ADD what is missing: an idea this meeting carried that no note mentions,',
  '  a decision, an owner, an open question. This is the main thing you are',
  '  for — you can now see the whole conversation at once.',
  '- FIX what the whole transcript shows to be wrong: a note that misread a',
  '  garbled word, a figure or a name the rest of the meeting corrects.',
  '- REORGANISE only where the notes are actually hard to read: a point filed',
  '  under the wrong heading, a topic left as a wall of bullets past the',
  '  regrouping bar. Bullets that read fine where they are stay where they',
  '  are.',
  '- Lines marked "theirs" are not yours: a person wrote them, or the document',
  '  no longer records who did. Never delete one, never move or nest one, and',
  '  do not repeat what they say.',
  '- YOU MAY STILL OFFER AN IMPROVEMENT ON A LINE MARKED "theirs", and you',
  '  cannot rewrite one by accident: name it in a replace_block with your',
  '  better wording and it reaches them as a SUGGESTION on their own line,',
  '  which they accept or reject. Their words do not change unless they say',
  '  so. Offer one only where the meeting shows something real — a figure or',
  '  a name the transcript contradicts, a point the room settled differently,',
  '  a note left hanging — never to restyle a line you would have worded',
  '  another way. One offer at most per line, and none at all if the line is',
  '  simply fine.',
  '- Do not open a new section, do not restate the transcript, and do not',
  '  write a summary of the meeting at the end.',
].join('\n');

/** How the transcript block is introduced, in place of the tick's own line. */
export const CLEANUP_TRANSCRIPT_LABEL = 'The whole meeting, as it was transcribed';
