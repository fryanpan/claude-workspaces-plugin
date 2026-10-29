/**
 * A tick is shown the speech just before its own, as context it must not
 * note again — so the third slice of a long answer is read knowing what the
 * first two were about. See `notes-recent-speech.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { buildNotesPrompt } from '../src/notes-prompt-build.ts';
import { RECENT_SPEECH_CHARS, recentBlock, recentSpeech } from '../src/notes-recent-speech.ts';
import { input } from './notes-compose-input.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

describe('recentSpeech', () => {
  test('keeps the end of the earlier speech, oldest first', () => {
    const prior = [
      { turn: 1, text: 'Harborlight signed the contract.' },
      { turn: 2, text: 'The Riverbend export is done.' },
    ];
    expect(recentSpeech(prior, []).map((t) => t.turn)).toEqual([1, 2]);
  });

  test('a turn that is also new speech is not shown twice', () => {
    const same = { turn: 2, text: 'The Riverbend export is done.' };
    const prior = [{ turn: 1, text: 'Harborlight signed.' }, same];
    expect(recentSpeech(prior, [same]).map((t) => t.turn)).toEqual([1]);
  });

  test('a long turn is cut from its start, at a word, and marked', () => {
    const long = `${'filler words here '.repeat(60)}and the Saltmarsh sync is still pending`;
    const [only] = recentSpeech([{ turn: 7, text: long }], [], 80);
    expect(only?.text.startsWith('…')).toBe(true);
    expect(only?.text.endsWith('the Saltmarsh sync is still pending')).toBe(true);
    expect((only?.text.length ?? 0) <= 81).toBe(true);
  });

  test('the bound holds across many turns', () => {
    const prior = Array.from({ length: 50 }, (_, i) => ({
      turn: i,
      text: 'Forty characters of ordinary speech ok.',
    }));
    const total = recentSpeech(prior, []).reduce((n, t) => n + t.text.length, 0);
    expect(total <= RECENT_SPEECH_CHARS + 1).toBe(true);
  });

  test('an empty block for nothing to show', () => {
    expect(recentBlock([], () => '')).toBe('');
  });
});

describe('the prompt', () => {
  test('carries the earlier speech before the new speech, marked as already noted', () => {
    const user = buildNotesPrompt({
      ...input,
      recent: [{ turn: 2, text: 'Alice said the Harborlight export is finished.' }],
    }).user;
    const ctx = user.indexOf('Alice said the Harborlight export is finished.');
    const fresh = user.indexOf('The sync is the bottleneck.');
    expect(ctx).toBeGreaterThan(-1);
    expect(ctx).toBeLessThan(fresh);
    expect(user).toContain('Write no note for it.');
  });

  test('a prompt with no earlier speech has no such block', () => {
    expect(buildNotesPrompt(input).user).not.toContain('Speech just before the new speech');
  });
});

describe('a session', () => {
  test('hands the second tick the first tick’s speech, and the first tick none', async () => {
    const h = createNotesTickHarness({ compose: () => [] });
    await h.speak('The Harborlight export is finished.');
    await h.speak('And the sync is still pending.');
    const [first, second] = h.snapshots;
    expect(first?.input?.recent).toBeUndefined();
    expect(second?.input?.recent?.map((t) => t.text)).toEqual([
      'The Harborlight export is finished.',
    ]);
    expect(second?.input?.tick.turns.map((t) => t.text)).toEqual([
      'And the sync is still pending.',
    ]);
  });
});
