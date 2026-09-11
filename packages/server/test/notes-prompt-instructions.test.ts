/**
 * The instructions a tick sends: the shipped words, and the one cut a
 * meeting's shape makes to them. The rest of what a tick asks the model —
 * the delta, the doc as blocks, the cache order — is
 * `notes-prompt-build.test.ts`.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNotesPrompt } from '../src/notes-prompt-build.ts';
import { DEFAULT_NOTES_INSTRUCTIONS } from '../src/notes-prompt-store.ts';
import { MAX_BULLET_WORDS, MAX_FLAT_RUN_BULLETS } from '../src/notes-quality.ts';
import { input } from './notes-compose-input.ts';

/**
 * The shipped words are Bryan's "Simplified Technical English, short" draft
 * (2026-09-11), word for word. The fixture is a copy of that section; the only
 * differences allowed are the two numbers the code interpolates, and both
 * read as the draft's own today.
 */
describe('the shipped notes prompt', () => {
  it('is the Simplified Technical English draft, word for word', () => {
    const draft = readFileSync(
      join(import.meta.dir, 'fixtures', 'notes-prompt-ste-short.md'),
      'utf8',
    ).trim();
    expect(MAX_BULLET_WORDS).toBe(20);
    expect(MAX_FLAT_RUN_BULLETS).toBe(4);
    expect(DEFAULT_NOTES_INSTRUCTIONS).toBe(draft);
  });
});

/**
 * A meeting with one voice in it is shown transcript lines carrying no name,
 * and used to be sent instructions demanding a speaker tag on every note —
 * with "Speaker B" spelled out as what such a name looks like. A model asked
 * for a name it has not been given supplies one, which is how a solo huddle
 * came out written as a conversation between Speaker A and Speaker B.
 *
 * The cut is the whole `### Speakers and links` section, found by its
 * HEADING. It used to be a list of exact sentences, so rewording one on the
 * settings page silently put the rule back into every solo meeting.
 */
describe('a solo meeting drops the speakers section, by its heading', () => {
  const solo = { ...input, multiSpeaker: false };
  const multi = { ...input, multiSpeaker: true };
  /** The shipped prompt with the speakers section reworded end to end, and a
   *  section after it — the cut has to stop at the next heading. */
  const reworded = DEFAULT_NOTES_INSTRUCTIONS.replace(
    /### Speakers and links[\s\S]*$/,
    [
      '###   speakers AND links',
      '',
      '- Say who made each point, written as [@Speaker C](speaker:C) at the front.',
      '- Link a board task the first time it comes up.',
      '',
      '### Closing',
      '',
      '- End each topic with its owner.',
    ].join('\n'),
  );

  it('sends no speakers section, and no spelling for a name', () => {
    const { system } = buildNotesPrompt(solo);
    expect(system).not.toContain('### Speakers and links');
    expect(system).not.toContain('Speaker B');
    expect(system).not.toContain('speaker:LABEL');
  });

  it('drops the section even when every line of it has been reworded', () => {
    const { system } = buildNotesPrompt(solo, reworded);
    expect(system).not.toMatch(/speakers and links/i);
    expect(system).not.toContain('[@Speaker C](speaker:C)');
    expect(system).not.toContain('Link a board task');
    // Up to the next heading, and no further.
    expect(system).toContain('### Closing\n\n- End each topic with its owner.');
  });

  it('keeps every section that is not about who spoke', () => {
    const { system } = buildNotesPrompt(solo);
    for (const heading of ['Input', 'Output Format', 'Edits', 'Notes', 'Grouping', 'Accuracy']) {
      expect(system).toContain(`### ${heading}\n`);
    }
    expect(system).toContain('Edit only blocks marked "yours".');
    expect(system).toContain('Each note is one markdown list item.');
  });

  it('a multi-speaker tick keeps the section, byte for byte', () => {
    // The positive control. A gate that removed the section from every
    // prompt would pass the assertions above and silently stop the notes
    // ever saying who decided anything.
    const both = buildNotesPrompt(multi).system;
    expect(both).toContain('### Speakers and links');
    expect(both).toContain('[@Name](speaker:LABEL)');
    expect(both).toBe(DEFAULT_NOTES_INSTRUCTIONS);
    expect(both).toBe(buildNotesPrompt(input).system);
  });

  it('a multi-speaker tick keeps a reworded section too', () => {
    expect(buildNotesPrompt(multi, reworded).system).toBe(reworded);
  });
});
