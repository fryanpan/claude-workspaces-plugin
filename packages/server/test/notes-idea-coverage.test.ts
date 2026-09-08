/**
 * The ledger that answers "did any note come of that?".
 *
 * Every case here drives the real functions over real sentences and reads the
 * verdict back. The one thing deliberately NOT asserted is the exact wording
 * of the stoplist or the share threshold: those are tuning, and a test that
 * pinned them would fail on every improvement to the proxy while saying
 * nothing about whether it works.
 *
 * All speech here is synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import type { NotesTurn } from '../src/meeting-notes.ts';
import {
  contentWords,
  createIdeaLedger,
  extractIdeas,
  ideaCarried,
} from '../src/notes-idea-coverage.ts';

const turn = (n: number, text: string): NotesTurn => ({ turn: n, text, speaker: 'Devi' });

describe('what counts as an idea', () => {
  it('finds one per substantive sentence and none in a backchannel', () => {
    const ideas = extractIdeas([
      turn(1, 'Okay. Right, yeah. The export dialog forgets the range people picked.'),
      turn(2, 'Mhm.'),
    ]);
    expect(ideas.map((i) => i.text)).toEqual([
      'The export dialog forgets the range people picked.',
    ]);
    expect(ideas[0]?.turn).toBe(1);
    expect(ideas[0]?.speaker).toBe('Devi');
  });

  it('keeps a brief sentence that mattered', () => {
    // The rule the prompt now states — a short important sentence stays — has
    // to be a rule the ledger can see, or the metric marks the note-taker
    // down for obeying it and up for dropping it.
    const ideas = extractIdeas([turn(1, 'We ship Tuesday.')]);
    expect(ideas).toHaveLength(1);
  });

  it('splits a turn that carried two subjects', () => {
    const ideas = extractIdeas([
      turn(1, 'The export dialog forgets the range. Separately, billing wants a CSV column.'),
    ]);
    expect(ideas).toHaveLength(2);
  });
});

describe('whether the notes carry an idea', () => {
  const idea = extractIdeas([
    turn(1, 'The export dialog forgets the date range people picked.'),
  ])[0]!;

  it('accepts a paraphrase that keeps the subject', () => {
    expect(ideaCarried(idea, '- The export dialog loses the chosen date range.')).toBe(true);
  });

  it('refuses notes about a different subject', () => {
    expect(ideaCarried(idea, '- Billing wants a new column in the invoice CSV.')).toBe(false);
  });

  it('refuses an empty set of notes', () => {
    expect(ideaCarried(idea, '')).toBe(false);
  });

  it('sees through a plural and a tense', () => {
    expect(contentWords('dialogs picking ranges')).toEqual(contentWords('dialog picked range'));
  });
});

describe('the ledger retries once and then counts the idea lost', () => {
  const spoke = [turn(1, 'The export dialog forgets the date range people picked.')];

  it('hands the idea back for one more tick, then gives up on it', () => {
    const ledger = createIdeaLedger();
    ledger.see(spoke);
    expect(ledger.coverage.seen).toBe(1);

    // First verdict: the notes say nothing about it, so it is re-sent.
    const retry = ledger.settle('- Somebody will look at the billing CSV.');
    expect(retry.map((i) => i.text)).toEqual([spoke[0]!.text]);
    expect(ledger.coverage).toMatchObject({ retried: 1, lost: 0, carried: 0 });

    // Second verdict on the same notes: no third chance.
    expect(ledger.settle('- Somebody will look at the billing CSV.')).toEqual([]);
    expect(ledger.coverage).toMatchObject({ retried: 1, lost: 1, carried: 0 });
    expect(ledger.pending).toBe(0);
  });

  it('counts a retry that landed as carried, not as lost', () => {
    const ledger = createIdeaLedger();
    ledger.see(spoke);
    expect(ledger.settle('- Nothing about it yet.')).toHaveLength(1);
    ledger.settle('- The export dialog loses the chosen date range.');
    expect(ledger.coverage).toMatchObject({ seen: 1, carried: 1, lost: 0, retried: 1 });
  });

  it('counts a retried sentence once, however often it is re-sent', () => {
    // A retry puts the words back into the next tick's speech, so the ledger
    // meets them again. Counting them twice would let the mitigation inflate
    // its own denominator.
    const ledger = createIdeaLedger();
    ledger.see(spoke);
    ledger.settle('');
    ledger.see(spoke);
    expect(ledger.coverage.seen).toBe(1);
  });

  it('close() judges what is still pending and retries nothing', () => {
    const ledger = createIdeaLedger();
    ledger.see(spoke);
    ledger.close('- The export dialog loses the chosen date range.');
    expect(ledger.coverage).toMatchObject({ seen: 1, carried: 1, lost: 0 });

    const missed = createIdeaLedger();
    missed.see(spoke);
    missed.close('- Unrelated.');
    expect(missed.coverage).toMatchObject({ seen: 1, carried: 0, lost: 1 });
    expect(missed.pending).toBe(0);
  });
});
