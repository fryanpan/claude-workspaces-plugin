/**
 * The unfiled-ask judgement: does a closing message ask the owner something,
 * and has the session put that ask anywhere the owner reads?
 *
 * Every case below is a SHAPE that was read off real end-of-turn messages
 * during the 2026-09-10 labelling run and then rewritten as fiction — the
 * corpus is the owner's own board and none of it enters this repo. The shapes
 * are what matters: the detector's whole job is to tell an offer from a
 * report of one, and the tests that earn their runtime are the near-misses.
 *
 * Fixtures are synthetic; agent names are invented. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { detectAsk, judgeTurnNote, nudgeLine, proseOf } from '../src/unfiled-ask.ts';

const asks = (text: string, owners: string[] = []): boolean => detectAsk(text, owners).ask;

describe('detectAsk — what counts as an ask', () => {
  it('counts an offer put to the reader', () => {
    expect(asks('Both arms are green. Want me to file the follow-up ticket?')).toBe(true);
  });

  it('counts a question addressed to the reader with no offer in it', () => {
    expect(asks('Burn is down to 61%. Is the cap of 2 on the Riverbend board yours?')).toBe(true);
  });

  it('counts a stock deferral with no question mark', () => {
    expect(asks('Three commits are ready. Say the word and I will push.')).toBe(true);
    expect(asks('The rewrite is drafted — your call whether it ships tonight.')).toBe(true);
  });

  it('counts a wait named in the third person, which is how a lead writes it', () => {
    expect(
      asks('Two builders running. Waiting on Harborlight for the cut-shape answer.', [
        'Harborlight',
      ]),
    ).toBe(true);
  });

  it('knows the owner only from the names it was given', () => {
    const wait = 'Two builders running. Waiting on Harborlight for the cut-shape answer.';
    expect(asks(wait, ['Harborlight'])).toBe(true);
    expect(asks(wait, ['Riverbend'])).toBe(false);
  });
});

describe('detectAsk — what must stay silent', () => {
  it('ignores a question with nobody in it', () => {
    // The agent thinking aloud at the end of a paragraph. No reader, no ask.
    expect(asks('Worth a pass that asks of every threshold: what was this measured against?')).toBe(
      false,
    );
  });

  it('ignores a question mark inside code', () => {
    expect(asks('The sweep reads `shares ? scoped : all`, which is why it returned nothing.')).toBe(
      false,
    );
    expect(asks('My drift check ran `python3 report.py | tail; echo $?` and I misread it.')).toBe(
      false,
    );
  });

  it('ignores somebody else’s question quoted back', () => {
    expect(asks('Answered the stale thread: "How do I get you more access?" — done.')).toBe(false);
  });

  it('ignores a negated wait, which reports the OPPOSITE', () => {
    expect(asks('Verified from their repos. Nothing there is blocked on you tonight.')).toBe(false);
    expect(asks('Dispatch registered. Nothing else needs your input now.')).toBe(false);
  });

  it('ignores an ask reported as made of somebody else', () => {
    expect(asks('I told the builder that the headline is your call, so it should not pre-cut.')).toBe(
      false,
    );
  });
});

describe('proseOf', () => {
  it('keeps link text and drops the target', () => {
    expect(proseOf('See [the decision](https://example.invalid/x) for the options.')).toContain(
      'the decision',
    );
    expect(proseOf('See [the decision](https://example.invalid/x) for the options.')).not.toContain(
      'example.invalid',
    );
  });

  it('does not weld two sentences together when it removes a span', () => {
    // A removed code span that closed one sentence must not let the next
    // sentence's subject count as the previous sentence's reader.
    const out = proseOf('The value is `a ? b : c`. Nothing is pending.');
    expect(out).toContain('The value is');
    expect(out).toContain('Nothing is pending.');
    expect(out).not.toContain('?');
  });
});

describe('judgeTurnNote — the ask plus the filing', () => {
  const ASK = 'The rewrite is drafted — your call whether it ships tonight.';

  it('nudges when an ask has no item behind it', () => {
    const v = judgeTurnNote(ASK, { openItem: false, filedSince: false });
    expect(v.ask).toBe(true);
    expect(v.filed).toBe(false);
    expect(v.nudge).toBeTypeOf('string');
  });

  it('stays silent when the session filed one this turn', () => {
    const v = judgeTurnNote(ASK, { openItem: false, filedSince: true });
    expect(v.ask).toBe(true);
    expect(v.nudge).toBeUndefined();
  });

  it('stays silent when the session already has one open — chat was a pointer', () => {
    const v = judgeTurnNote(ASK, { openItem: true, filedSince: false });
    expect(v.nudge).toBeUndefined();
  });

  it('stays silent on a message that asks nothing, filed or not', () => {
    const plain = 'Merged and deployed; the task is closed.';
    expect(judgeTurnNote(plain, { openItem: false, filedSince: false }).nudge).toBeUndefined();
    expect(judgeTurnNote(plain, { openItem: false, filedSince: false }).ask).toBe(false);
  });
});

describe('nudgeLine', () => {
  it('names the phrase it fired on, so a wrong reading is visible at a glance', () => {
    expect(nudgeLine([{ kind: 'deferral', phrase: 'your call' }])).toContain('your call');
  });

  it('admits its own error rate, because it will be wrong', () => {
    expect(nudgeLine([{ kind: 'question', phrase: '?' }])).toMatch(/wrong about one message in six/);
  });
});
