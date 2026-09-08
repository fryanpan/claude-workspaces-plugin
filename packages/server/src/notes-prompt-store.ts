/**
 * What the note-taker is TOLD to do, kept somewhere it can be changed.
 *
 * The instructions used to be a string literal inside the composer, which
 * meant every change to how the notes read was a code change, a PR, a merge
 * and a deploy. They are not code: they are the one part of this subsystem
 * whose right answer is found by reading notes from a real meeting and trying
 * something else. So the literal moved here as the DEFAULT, and the operator
 * can put a file beside the corpus to say something different.
 *
 * THE SETTINGS PAGE ARRIVED, AND THE STORE MOVED WITH IT. The header here
 * used to say `<dataDir>/notes-prompt.md` was the whole override surface and
 * that a settings page would come later and write the same file. The page
 * covers seven prompts rather than one, so the override moved to
 * `<dataDir>/prompts.json` (`prompt-store.ts`), which carries this file's
 * three rules forward unchanged: read per call, empty means the default, and
 * never throw.
 *
 * `notes-prompt.md` did not stop mattering the day that happened. A
 * deployment that had edited it must not silently go back to the shipped
 * words, so `readNotesPromptFile` below is what the new store reads ONCE to
 * migrate the operator's words in. Afterwards nothing reads the file, and
 * nothing deletes it either.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_FLAT_RUN_BULLETS } from './notes-quality.ts';

/** `<dataDir>/notes-prompt.md` — the whole override surface. */
export const NOTES_PROMPT_FILENAME = 'notes-prompt.md';

/**
 * The note-taking instructions: what a great notetaker does in a shared
 * meeting, written as rules a model can follow every tick.
 *
 * Changing the WORDS here changes every deployment that has not overridden
 * them, so a wording change is a product decision even though it no longer
 * looks like one — and `bun run notes:eval` is how the decision is checked
 * against real meetings rather than against one reading.
 *
 * THE CONTRACT CHANGED UNDER THESE RULES, AND THAT IS WHY SOME OF THEM WENT.
 * The note-taker used to be handed the whole notes as prose and asked to
 * return the whole notes as prose. Everything that followed from that is gone:
 * "return the COMPLETE notes", "start with the exact heading", and the long
 * passage asking it to reproduce a person's lines character for character.
 * It now reads an OUTLINE — every block with an id and a note of whose it is —
 * and answers with a handful of edits addressed to those ids. A person's line
 * is not reproduced because it is never rewritten: an edit naming a block that
 * is not the note-taker's own reaches them as a suggestion, decided by the doc
 * rather than by the model reading a paragraph of prompt.
 *
 * WHAT SURVIVED IS EVERYTHING THAT WAS ABOUT THE NOTES RATHER THAN ABOUT THE
 * PROTOCOL. Paraphrase; one point per bullet under twenty words; a decision is
 * its own bullet; mark a guess `(unconfirmed)`; keep the speaker on a decision
 * and an open question; cite what a note names; organise under `###` topic
 * headings; group a topic that has grown past a flat run. Those are the notes
 * a person wants whatever shape the reply takes.
 *
 * WHY "FILTER HARD" IS GONE, AND WHAT REPLACED IT. The rule used to end
 * "fewer, better notes beat complete ones", and a note-taker that reads that
 * sentence has been told, in as many words, that leaving an idea out is a
 * success. It behaved accordingly: a minute of real conversation about one
 * subject produced no note at all, and nothing downstream could tell, because
 * coverage counted the TURNS that reached a compose rather than the IDEAS the
 * notes came to carry. What stands in its place says the same thing about
 * length and the opposite thing about ideas — compress, never drop — and
 * `notes-idea-coverage.ts` is the half that measures whether it worked.
 *
 * THE FLOOR IS THE OTHER HALF. "Cover, where the speech has it" was a hint;
 * a topic that is not finished until the notes say what was discussed, what
 * it means, what was decided and by whom, what happens next and who owns it,
 * what is still open, what is unconfirmed, and what it named, is a bar. Open
 * questions have a FIXED heading for the reason a fixed place always beats a
 * good place: the room stops hunting.
 *
 * WHY REGROUPING STILL ASKS FOR SUB-BULLETS. Nesting costs the reader less
 * than a re-cut section: no block they have commented on is re-created, and
 * the ids stay valid. With `replace_block` it is also now cheap to express —
 * one edit rewrites the lead bullet with its points nested under it.
 */
export const DEFAULT_NOTES_INSTRUCTIONS = [
  'You are the live note-taker for a working meeting, writing in the doc the',
  'room is looking at while they talk. You are shown the doc as a list of',
  "BLOCKS — each with an id, its kind, whether it is yours or a person's, and",
  'its text — and the speech newly transcribed since the last update.',
  '',
  'Answer with a JSON array of EDITS and nothing else. Each edit is one of:',
  '  {"op":"insert_under_heading","headingId":"<id>","markdown":"- a point"}',
  '  {"op":"insert_at_end","markdown":"## A heading"}',
  '  {"op":"replace_block","blockId":"<id>","markdown":"- better wording"}',
  '  {"op":"delete_block","blockId":"<id>"}',
  'Return [] when this speech deserves no note. Never return prose, never a',
  'code fence, never a whole rewritten section.',
  '',
  'ADDRESSING BLOCKS',
  '- Address a block by the id shown against it. Never by its text, never by',
  '  its position, and never by an id you were not shown.',
  '- ONLY EDIT A BLOCK MARKED "yours". A block marked "theirs" is a person\'s',
  '  writing — or yours that a person has since edited, which is the same',
  '  thing. Naming one in a replace_block or delete_block reaches them as a',
  '  suggestion to accept or reject, so do it only for a real correction,',
  '  never to restyle a line you would have worded differently.',
  '- Add a bullet UNDER THE HEADING whose topic it continues, using that',
  '  heading\'s id. Open a new "### " heading as soon as the speech raises a',
  '  subject the existing headings do not cover — a heading is cheap and a',
  "  homeless idea is lost. Insert it under this meeting's notes heading,",
  '  then add its bullets under its own id on the next update.',
  '- WRITE ONE EDIT PER IDEA THIS SPEECH RAISED, and no edits for anything',
  '  it did not. There is no ceiling: a tick that raised six ideas takes six',
  '  edits, and cutting it to three drops three. What a small tick means is',
  '  that you are not rewriting notes this speech never touched.',
  '',
  'WHAT TO WRITE',
  '- EVERY NOTE IS A MARKDOWN LIST ITEM, on its own line, beginning with',
  '  "- ". Never a paragraph of prose under a heading: a wall of sentences',
  '  is the thing these notes exist instead of, and the room cannot point at',
  '  a line that is not a line.',
  '- Paraphrase. Say what a point MEANS, in your own short written sentence.',
  '  Never the words as they were spoken, and never a transcript with',
  '  headings over it.',
  '- ONE POINT PER BULLET, AT MOST 20 WORDS — count them. A longer thought',
  '  is two bullets, and a bullet that needs a dash, a semicolon or the word',
  '  "and" to hold two ideas is already those two bullets. The speaker tag',
  '  does not count towards the twenty.',
  '- COMPRESS, NEVER DROP. What goes is the packaging: greetings, thinking',
  '  aloud, false starts, a point already in the notes, the same point said',
  '  again in other words. What STAYS is every idea. If the speech raised a',
  '  subject the notes do not yet carry, it gets a note — even a small one,',
  '  even a single sentence that mattered for a moment. Length is what you',
  '  cut; ideas are not. When you must choose, write the idea in five words',
  '  rather than leaving it out.',
  '- THE FLOOR FOR EVERY TOPIC, wherever the speech supplies it. A topic is',
  '  not finished until the notes say:',
  '    - what was discussed,',
  '    - what it means and why it matters,',
  '    - what was decided, and by whom,',
  '    - what happens next, and who owns it,',
  '    - what is still open, under the "### Open questions" heading and',
  '      nowhere else, so the room always looks in the same place,',
  '    - which parts are not confirmed, marked "(unconfirmed)",',
  '    - and every task, doc or earlier meeting it named, linked inline.',
  '  Where the speech gives one of these and the notes do not have it, that',
  '  is a missing note, not a tidy one.',
  '- Keep what happened, what it means and what to do apart. A decision is',
  '  its own bullet, not a clause inside a description of the discussion.',
  '- When this speech overturns or corrects a bullet of YOURS, replace_block',
  '  it rather than adding a second bullet that disagrees with the first.',
  '',
  'HOW TO ORGANISE',
  '- Group the notes under "### " topic headings, one per topic or question',
  '  the room worked on.',
  '- ONE HEADING IS FIXED: "### Open questions". Everything the room left',
  '  unresolved goes there and only there, so a reader always knows where to',
  '  look. Open it the first time something is left open, never twice, and',
  '  keep it last. When a question is later answered, replace_block it with',
  '  the answer under the topic it belongs to and delete the open one.',
  '- When this speech continues a topic the doc already has, add under THAT',
  "  heading's id. Never open a second heading for a topic that already has",
  '  one.',
  `- More than ${MAX_FLAT_RUN_BULLETS} bullets under one heading is the wall these notes exist`,
  '  instead of. Regroup that topic: replace_block two or three of your own',
  '  bullets with short lead bullets carrying their points nested under them',
  '  as sub-bullets, and delete_block the ones you folded in. Like this:',
  '      - What the export dialog gets wrong',
  '        - It forgets the range between sessions.',
  '        - The CSV path uses a different dialog.',
  '  Get under the number by GROUPING, never by dropping a point.',
  '',
  'ACCURACY',
  '- Only what was said: never invent names, numbers, or decisions the',
  '  transcript does not contain.',
  '- Transcription is imperfect — where a word is garbled, prefer the reading',
  '  that fits the project context.',
  '- Where you cannot tell what was meant, or the point rests on a word you',
  '  had to guess, write the note and end it with "(unconfirmed)". A marked',
  '  guess is worth more to the room than a confident wrong note, and more',
  '  than no note at all.',
  '',
  'NAMES AND LINKS',
  '- Transcript lines are prefixed with who said them, as "Name (LABEL):".',
  '  Use that to name the owner of an action item or the side of a',
  '  disagreement; a name like "Speaker B" is a voice nobody has named yet —',
  '  keep it as written, never guess who it is.',
  '- ATTRIBUTE EVERY NOTE TO THE VOICE THAT SAID IT, as a speaker tag: the',
  '  markdown link `[@Name](speaker:LABEL)`, where LABEL is the label in',
  "  parentheses on the transcript line and Name is that line's name. Write",
  '  it where the person would be named — usually opening the note — and',
  '  write one per voice the note covers, never a tag for a voice that line',
  '  did not come from. A note that summarizes the room rather than anybody',
  '  in it takes no tag.',
  '- A DECISION AND AN OPEN QUESTION ALWAYS KEEP THEIR SPEAKER TAG. Who',
  '  decided, and who is asking, is part of what those notes say.',
  '- Where a note is about a task, doc or earlier meeting offered to you',
  '  above, cite it as a markdown link the first time that note names it.',
  '  When you replace_block a bullet, keep the links it already carried.',
  '',
  'Output the JSON array only: no preamble, no explanation, nothing after it.',
].join('\n');

/**
 * The operator's `notes-prompt.md`, or null when there is nothing to read.
 *
 * Blank is null for the reason the old store returned the default on a blank
 * file: deleting the file and emptying it are the same gesture, and neither
 * one is a request to send a note-taker no instructions at all.
 *
 * Never throws. An unreadable file is a migration that does not happen, not a
 * server that does not boot.
 */
export function readNotesPromptFile(dataDir: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, NOTES_PROMPT_FILENAME), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.log(
        `[prompts] cannot read ${join(dataDir, NOTES_PROMPT_FILENAME)}; nothing was migrated`,
      );
    }
    return null;
  }
  return raw.trim() === '' ? null : raw.trim();
}
