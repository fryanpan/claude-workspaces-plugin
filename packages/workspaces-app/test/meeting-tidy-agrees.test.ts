/**
 * The two surfaces that can report one tidy-up, given the SAME reply.
 *
 * WHY THIS FILE EXISTS. The dialog and the strip's idle line answer the same
 * question about the same pass, and on 2026-09-16 they answered it
 * differently: the dialog named the cause and removed its primary, while the
 * strip said "The tidy-up could not run — the notes are unchanged." and left
 * an underlined offer that would fail identically on every press. Each
 * surface's own file could pass while that was true, because neither of them
 * ever saw the other. This one drives both modules over one reply and asserts
 * they agree — on the words, and on whether anything is left to press.
 *
 * Both are driven for real: `mountMeetingCleanupOffer` renders into the DOM
 * and is read off its markup, and `runMeetingTidyUp` is fed the same
 * `Response`. Nothing here reads source text.
 *
 * Fictional names throughout; the repo is public.
 */

import { describe, expect, it } from 'vitest';
import { runMeetingTidyUp } from '../src/meeting-tidy-line.ts';
import { goEl, goLabel, headlineEl, mount, offerEl, stubFetch } from './cleanup-offer-harness.ts';
import { REPLIES } from './meeting-tidy-replies.ts';

/** What the dialog put on screen for one reply. */
async function dialogSays(reply: {
  status: number;
  body: unknown;
}): Promise<{ headline: string; offers: boolean; label: string; closed: boolean }> {
  const offer = mount(stubFetch(reply));
  offer.offer('m-1');
  goEl().click();
  // The click awaits the fetch, reads the body, then writes the dialog. Three
  // turns of the microtask queue covers all of it; `waitFor` would too, and
  // this is deterministic.
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  const closed = offerEl().hidden;
  return {
    headline: closed ? '' : (headlineEl().textContent ?? ''),
    // The primary is REMOVED, not greyed, when another press cannot answer
    // differently — `hidden` and `disabled` move together there.
    offers: !closed && !goEl().hidden && !goEl().disabled,
    label: closed ? '' : goLabel(),
    closed,
  };
}

/** And what the strip's line made of the very same reply. */
async function stripSays(reply: { status: number; body: unknown }): Promise<{
  note: string;
  offers: boolean;
  closed: boolean;
}> {
  const out = await runMeetingTidyUp({
    docId: 'd-ferry',
    meetingId: 'm-1',
    fetchImpl: stubFetch(reply),
  });
  if (out.kind === 'changed') return { note: '', offers: false, closed: true };
  return { note: out.note, offers: out.retry, closed: false };
}

const CASES = [
  ['a server with no model key', REPLIES.noComposer],
  ['a recording going on the doc', REPLIES.recording],
  ['a pass whose every edit was refused', REPLIES.nothingLanded],
  ['a pass that found nothing to improve', REPLIES.nothingToChange],
  ['a pass that changed something', REPLIES.changed],
] as const;

describe('the dialog and the strip, given one reply', () => {
  for (const [what, reply] of CASES) {
    it(`say the same thing about ${what}`, async () => {
      const dialog = await dialogSays(reply);
      const strip = await stripSays(reply);
      // A pass that moved the notes closes one and ends the other: the notes
      // are the receipt, and neither surface has anything left to say.
      expect(strip.closed, what).toBe(dialog.closed);
      if (dialog.closed) {
        expect(strip.note).toBe('');
        expect(strip.offers).toBe(false);
        return;
      }
      // THE SAME WORDS, not a paraphrase per surface. The strip is one line,
      // so it carries the headline alone and leaves the grouped per-edit
      // reasons to the dialog's card — but the sentence itself is one string
      // from one reader.
      expect(strip.note, what).toBe(dialog.headline);
      // And the same answer to "is there anything left to press?".
      expect(strip.offers, what).toBe(dialog.offers);
    });
  }

  /**
   * The case the defect was about, stated on its own so a regression names
   * itself rather than arriving as one row of a table.
   */
  it('both name the missing model key, and neither leaves a press standing', async () => {
    const dialog = await dialogSays(REPLIES.noComposer);
    const strip = await stripSays(REPLIES.noComposer);
    expect(dialog.headline).toContain('no model key');
    expect(strip.note).toContain('no model key');
    expect(dialog.offers).toBe(false);
    expect(strip.offers).toBe(false);
  });

  /** Control: a reply a person CAN clear leaves both offering, so the case
   *  above is reading the reply rather than a surface that never offers. */
  it('both keep the offer for a refusal a person can clear', async () => {
    const dialog = await dialogSays(REPLIES.recording);
    const strip = await stripSays(REPLIES.recording);
    expect(dialog.offers).toBe(true);
    expect(strip.offers).toBe(true);
    expect(dialog.label).toBe('Try again');
  });
});
