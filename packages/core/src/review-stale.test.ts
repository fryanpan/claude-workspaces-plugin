/**
 * When an open ask stops applying: its anchor is orphaned, or its asker's own
 * later reply settles it. The phrase rule is narrow on purpose; the misses it
 * names in its header are asserted here as misses, so widening it is a
 * deliberate change. Fixtures are invented.
 */
import { describe, expect, it } from 'vitest';
import { settlesAsk, staleAsk } from './review-stale.ts';

const AGENT = { id: 'agent-harborlight', name: 'Harborlight' };
const ALICE = { id: 'known-alice', name: 'Alice' };
const ask = {
  id: 'c1',
  ts: 100,
  text: 'Alice, keep the Riverbend button?',
  author: AGENT,
  review: { headline: 'Keep the Riverbend button?' },
};
const reply = (id: string, ts: number, text: string, author = AGENT) => ({ id, ts, text, author });

describe('settlesAsk', () => {
  const HEADLINE = 'Keep the Riverbend button?';

  it.each([
    // Moot phrases that name the ask itself.
    'I removed the Riverbend button in this round, so this is no longer needed.',
    'This is moot now.',
    'Never mind, I went ahead with the default.',
    'Please disregard this question.',
    // A removal whose sentence names what the ask was about.
    'I removed the Riverbend button.',
    'The button was removed in the last round.',
  ])('settles: %s', (text) => {
    expect(settlesAsk(text, HEADLINE)).toBe(true);
  });

  it.each([
    'I removed the button. Should the link go too?',
    'I removed the old log line; still need your answer on the button.',
    'Here is the Riverbend chart for you to look at.',
    // Progress on something else is not a settlement (Codex review, PR 1251).
    'The retry error is now fixed; I am evaluating the two options.',
    'Already done: the benchmark ran overnight.',
    'I removed the stale log line from the Saltmarsh job.',
    'The old cache is no longer needed.',
    // Named misses: paraphrase and a bare "done".
    "The button's gone.",
    'Done.',
  ])('does not settle: %s', (text) => {
    expect(settlesAsk(text, HEADLINE)).toBe(false);
  });
});

describe('settlesAsk, when the removal names its subject by a pronoun', () => {
  // The thread that prompted the rule, in fixture words: the asker removed
  // the option, said why, and offered to redo it only if asked.
  const HEADLINE = 'Should the tool keep a Riverbend option, and if so, what should it do?';

  it.each([
    "I removed it, since it didn't stand for any real route change. If we want Riverbend back as an option, it should model actual added harbour trips, and I'll do that only if you want it.",
    'I removed the option.',
    'We have deleted this; it was never wired up.',
    'It was removed in the last round.',
  ])('settles: %s', (text) => {
    expect(settlesAsk(text, HEADLINE)).toBe(true);
  });

  it.each([
    // A question still blocks, however the removal is worded.
    'I removed it from the Saltmarsh export. Should the tool keep the option?',
    'I removed it from the log; still want your call on the option.',
    // Keeping it, or a pronoun with no removal, settles nothing.
    'I kept it, since it stands for a real route change.',
    "I'll remove it only if you want it.",
    // A denial is not a removal (Codex review).
    "I don't think I deleted it.",
    'I never removed it.',
    'Nobody has said we removed the option, so it stays.',
  ])('does not settle: %s', (text) => {
    expect(settlesAsk(text, HEADLINE)).toBe(false);
  });
});

describe('staleAsk', () => {
  it('is orphaned when the anchor is', () => {
    expect(staleAsk({ anchor: { kind: 'orphan', lastSeenAt: 150 }, comments: [ask] }, ask)).toEqual(
      { rule: 'orphaned', at: 150 },
    );
  });

  it("is settled by the asker's own later reply", () => {
    const t = {
      anchor: { kind: 'text-range' },
      comments: [ask, reply('c2', 200, 'I removed the Riverbend button.')],
    };
    expect(staleAsk(t, ask)).toEqual({ rule: 'settled', at: 200, commentId: 'c2' });
  });

  it('is settled by a reply posted in the same millisecond, after the ask', () => {
    // A clock read in milliseconds ties for two posts made back to back, and
    // the server suite makes them: CI read the ask still on Home after its
    // settling reply. Thread order breaks the tie; a tied comment BEFORE the
    // ask still settles nothing.
    const t = {
      anchor: { kind: 'text-range' },
      comments: [
        reply('c0', 100, 'I removed the Riverbend button.'),
        ask,
        reply('c2', 100, 'I removed the Riverbend button.'),
      ],
    };
    expect(staleAsk(t, ask)).toEqual({ rule: 'settled', at: 100, commentId: 'c2' });
    expect(staleAsk({ ...t, comments: t.comments.slice(0, 2) }, ask)).toBeUndefined();
  });

  it('is not settled by somebody else saying the same words, nor by an earlier comment', () => {
    const t = {
      anchor: { kind: 'text-range' },
      comments: [
        reply('c0', 50, 'I removed the Riverbend button.'),
        ask,
        reply('c2', 200, 'I removed the Riverbend button.', ALICE),
      ],
    };
    expect(staleAsk(t, ask)).toBeUndefined();
  });

  it('is not settled by a later declaration of the asker (a re-file is its own ask)', () => {
    const t = {
      comments: [
        ask,
        { ...reply('c2', 200, 'I removed the button, so this is moot.'), review: {} },
      ],
    };
    expect(staleAsk(t, ask)).toBeUndefined();
  });
});
