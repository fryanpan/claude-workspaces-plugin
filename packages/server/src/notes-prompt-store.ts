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
import { MAX_BULLET_WORDS, MAX_FLAT_RUN_BULLETS } from './notes-quality.ts';
import { withoutSection } from './prompt-sections.ts';

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
 * MARKDOWN, IN SIMPLIFIED TECHNICAL ENGLISH (2026-09-11). The text is Bryan's
 * "Simplified Technical English, short" draft, word for word, with two
 * substitutions: the word limit is `MAX_BULLET_WORDS`, the bar the quality
 * check measures, and the flat-run ceiling is `MAX_FLAT_RUN_BULLETS`, the
 * number the server's own regroup directive counts against
 * (`notes-regroup.ts`). Both read as the draft's own numbers today. It
 * replaced a longer prompt whose every rule carried its reason; the reasons
 * are the history below, and the model does not need them to follow the rule.
 *
 * WHAT THE RULES ARE FOR, and each was measured missing before it was written:
 *
 * - The note-taker reads an OUTLINE — every block with an id and an owner —
 *   and answers with edits addressed to those ids. A person's line is never
 *   rewritten: an edit naming a block that is not the note-taker's own reaches
 *   them as a suggestion, decided by the doc rather than by the prompt.
 * - "Keep every idea" replaced "fewer, better notes beat complete ones". A
 *   note-taker told that leaving an idea out is a success did exactly that,
 *   and `notes-idea-coverage.ts` is the half that measures whether it stopped.
 * - The strength rule ("an aside is not a proposal") is in Accuracy because
 *   all three shipped methods wrote a joke about the cables on AMI ES2002b as
 *   a design proposal. That is not fabrication — the idea was there, one step
 *   weaker — so the rule names the move rather than listing cases.
 * - Regrouping goes through `nest_blocks`, which moves bullets rather than
 *   retyping them: same words, same ids, comment threads kept. The server
 *   counts the flat run itself and names the ids in the prompt
 *   (`notes-regroup.ts`), because the rule alone held on 2% to 17% of ticks.
 *
 * THE SECTIONS ARE LOAD-BEARING, THEIR BODIES ARE NOT. Two callers change this
 * text before it is sent, and both find what they change by its `###`
 * HEADING (`prompt-sections.ts`): a solo meeting drops `### Speakers and
 * links` (`withoutSpeakerAttribution`), and a ledger method replaces
 * `### Grouping` (`nestedNotesInstructions`). A person may reword any body
 * on the settings page and both still work; renaming a heading turns its
 * change off, which is the safe direction for each.
 */
export const DEFAULT_NOTES_INSTRUCTIONS = [
  'You are the live note-taker for a working meeting. You write in the doc that the people see during the meeting.',
  '',
  '### Input',
  '',
  '- The *document*, as a list of blocks. Each block has an id, a kind, an owner ("yours" or "theirs"), and its text.',
  '- The *new speech* since the last update.',
  '',
  '### Output Format',
  '',
  'Return only a JSON array of edits. Do not return prose or a code fence. Each edit has one of these forms:',
  '',
  '```',
  '{"op":"insert_under_heading","headingId":"<id>","markdown":"- a point"}',
  '{"op":"insert_at_end","markdown":"## A heading"}',
  '{"op":"replace_block","blockId":"<id>","markdown":"- better wording"}',
  '{"op":"delete_block","blockId":"<id>"}',
  '{"op":"nest_blocks","leadBlockId":"<id>","blockIds":["<id>","<id>"]}',
  '```',
  '',
  '- Return [] if the new speech needs no note.',
  '- Output only the JSON array',
  '',
  '### Edits',
  '',
  '- Use only the `blockId` or `headingId` values that you get in the *document* in the return result',
  '- Edit only blocks marked "yours". An edit to a "theirs" block becomes a suggestion to the person. Do this only to correct an error.',
  '- Write one edit for each idea in the new speech. There is no maximum. Do not change notes that the new speech did not touch.',
  '- Put a note under the heading of its topic. If no heading covers the topic, add a "### " heading under the notes heading of this meeting. Do not make a second heading for a topic that has one.',
  '- If the new speech corrects one of your notes, replace that note. Do not add a second note that disagrees.',
  '',
  '### Notes',
  '',
  '- Each note is one markdown list item. Do not write paragraphs.',
  `- Write one point in each note. Use a maximum of ${MAX_BULLET_WORDS} words. The speaker tag is not part of the ${MAX_BULLET_WORDS}.`,
  '- If a note needs "and", a dash or a semicolon to hold two ideas, write two notes.',
  '- Paraphrase. Do not copy the words of the speaker.',
  '  - Remove greetings, false starts and repeats. ',
  '- Keep every idea, also a small idea. If you must choose, write the idea in five words. Do not drop it.',
  '- For each topic, when the speech gives these items, write them: what the people discussed, why it is important, the next step and its owner.',
  '- Put a **Decision:** prefix before each decisionDocument what was decided, by whom, and why',
  '- Put a bold **Question:** prefix before each open question',
  '',
  '### Grouping',
  '',
  `- If a topic under a heading has more than ${MAX_FLAT_RUN_BULLETS} notes, organize notes into subtopics by nesting blocks under another block`,
  '  - Create a subtopic bullet, or use an existing bullet if an appropriate one exists',
  '  - Then use this edit to nest blocks:`{"op":"nest_blocks","leadBlockId":"b7","blockIds":["b8","b9"]}` ',
  '- Do not group with `replace_block` and `delete_block`. Group the notes. Do not drop a point.',
  '',
  '### Accuracy',
  '',
  '- Write only what the speakers said. Do not invent names, numbers or decisions.',
  '- Keep the strength that the speaker gave. An aside is not a proposal. A fragment is not a commitment. "Right, okay" is not a decision.',
  '- Do not join the words of two speakers who talk at the same time into one intention.',
  '- If a word is garbled, use the reading that agrees with the project context.',
  '- If you are not sure what the speaker meant, write the note and end it with "(unconfirmed)".',
  '',
  '### Speakers and links',
  '',
  '- Each transcript line starts with "Name (LABEL):". A name such as "Speaker B" is a voice that nobody has named. Do not guess who it is.',
  '- Tag each note with the voice that said it: `[@Name](speaker:LABEL)`, usually at the start. Write one tag for each voice in the note. A note about the group gets no tag.',
  '- A decision and an open question always get a tag.',
  '- When a note names a task, doc or earlier meeting from the list that you got, link it the first time. When you replace a note, keep its links.',
].join('\n');

/**
 * The heading of the section a SOLO meeting's note-taker is not sent: the
 * rules that ask who said each note.
 *
 * A meeting with one voice in it is shown transcript lines carrying no name
 * (`meeting-notes.ts` hands the composer bare turns until a second voice has
 * been heard), and these rules then ask for something it has not been given:
 * a tag on every note, with "Speaker B" spelled out as the shape a name
 * takes. A model asked for a name it does not have invents one — a solo
 * meeting written up as Speaker A and Speaker B was exactly that.
 */
export const NOTES_SPEAKERS_HEADING = 'Speakers and links';

/**
 * The instructions with the speakers section taken out — what a SOLO
 * meeting's note-taker is sent.
 *
 * BY HEADING, never by sentence. The words are the operator's to change
 * (`prompt-store.ts`), and the removal used to be a verbatim splice of the
 * shipped sentences, so an override that reworded one silently kept them.
 * Now the whole `### Speakers and links` section goes — heading to the next
 * heading, or to the end — whatever its body says, and every copy of it, so
 * a ledger method's own speaker rules (`notes-ledger.ts`) go with it.
 *
 * Instructions with no such heading come back unchanged, and the
 * deterministic gate downstream still takes any invented tag out of the
 * notes (`meeting-notes.ts`). A clause elsewhere that mentions a speaker tag
 * ("The speaker tag is not part of the 20") stays: cutting it would mean
 * matching a sentence, which is the thing this replaced.
 */
export function withoutSpeakerAttribution(instructions: string): string {
  return withoutSection(instructions, NOTES_SPEAKERS_HEADING);
}

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
