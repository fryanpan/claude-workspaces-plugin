/**
 * What a retried line is still missing from the notes.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { missedBlock, wordsStillMissing } from '../src/notes-missed-words.ts';

describe('the words of a retried line that the notes do not carry', () => {
  it('names the reason when the notes kept the point and dropped it', () => {
    const line =
      'Put a reminder on it for the twentieth, because a contract sitting ' +
      'unsigned in an inbox is the same as no contract.';
    const notes = '- Reminder: follow up on the contract signature by the twentieth';
    // "Put" is a content word to the shared lexicon and the notes do not
    // carry it, so it is listed. A second stoplist here to drop it is the
    // two-vocabularies mistake `notes-quality-coverage.ts` was split up to end.
    expect(wordsStillMissing(line, notes)).toEqual(['Put', 'sitting', 'unsigned', 'inbox']);
  });

  it('names nothing when the notes carry the whole line', () => {
    const line = 'We move the survey to the first Monday of March.';
    const notes = '- Survey moves to the first Monday of March';
    expect(wordsStillMissing(line, notes)).toEqual([]);
  });

  it('names nothing when the notes carry none of it', () => {
    // A line nothing in the notes touches is missing as a whole, which the
    // retry block already says. Listing every word of it would be the
    // sentence again, one word per line.
    const line = 'The crane deposit is refundable up to a month out.';
    const notes = '- Survey moves to the first Monday of March';
    expect(wordsStillMissing(line, notes)).toEqual([]);
  });

  it('keeps the words as the speaker said them, not as the stemmer holds them', () => {
    const line = 'The estimates assumed the crane was free in the second week.';
    const notes = '- The estimate is nine percent under budget';
    // "estimates" stems to what the notes already carry; "assumed" does not,
    // and it reaches the prompt spelled the way it was said.
    expect(wordsStillMissing(line, notes)).toContain('assumed');
    expect(wordsStillMissing(line, notes)).not.toContain('estimates');
  });

  it('says each word once, however many times the line says it', () => {
    const line = 'A contract unsigned is no contract, and an unsigned contract is a risk.';
    const notes = '- The contract is drafted this week';
    expect(wordsStillMissing(line, notes)).toEqual(['unsigned', 'risk']);
  });
});

describe('the retry block a tick sends', () => {
  const bare = (): string => '';

  it('follows a part-carried line with the words no note has', () => {
    const block = missedBlock(
      [{ text: 'Put a reminder on it for the twentieth, because a contract is unsigned.' }],
      '- Reminder: follow up on the contract signature by the twentieth',
      bare,
    );
    expect(block).toContain('[no note has: Put, unsigned]');
  });

  it('follows a line the notes touch nowhere with nothing', () => {
    const block = missedBlock(
      [{ text: 'The crane deposit is refundable up to a month out.' }],
      '- Reminder: follow up on the contract signature by the twentieth',
      bare,
    );
    expect(block.endsWith('- The crane deposit is refundable up to a month out.')).toBe(true);
    expect(block).not.toContain('[no note has:');
  });

  it('keeps the speaker rendering its caller passes', () => {
    const block = missedBlock(
      [{ text: 'We hire the hulls.', speaker: 'Alice', speakerLabel: 'A' }],
      '- nothing related',
      (t) => `${t.speaker} (${t.speakerLabel}): `,
    );
    expect(block).toContain('- Alice (A): We hire the hulls.');
  });
});
