/**
 * What a tidy-up that changed nothing tells the person who asked for it.
 *
 * THE 15 SEPTEMBER FAILURE, AND ITS OTHER HALF. The pass read 355 turns,
 * proposed sixteen edits, had every one refused, and the dialog said one
 * sentence that could have meant anything. The gate has named a rule per
 * dropped edit since PR 1034 and the route now carries them; these cases are
 * those reasons, and the recovery beside them, reaching a person's screen.
 *
 * Every case drives the real dialog and reads the DOM it built. The wording
 * itself is decided by `readCleanupReply` in `@claude-workspaces/core` and
 * pinned there; what is pinned HERE is that the dialog renders it — the rows,
 * the recovery line, the button's label and whether it is live.
 *
 * Fictional names throughout; the repo is public.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  deferredFetch,
  dismissEl,
  goEl,
  goLabel,
  headlineEl,
  mount,
  offerEl,
  phase,
  reasonRows,
  reasonsEl,
  recoveryEl,
  stubFetch,
} from './cleanup-offer-harness.ts';

describe('what a tidy-up that changed nothing says', () => {
  it('names every rule that dropped an edit, with how many it dropped', async () => {
    const f = stubFetch({
      body: {
        ok: true,
        changed: false,
        proposed: 5,
        refused: 5,
        refusals: [
          'replace_block b1: the document does not record the block as the note-taker’s own',
          'replace_block b2: the document does not record the block as the note-taker’s own',
          'replace_block b3: the document does not record the block as the note-taker’s own',
          'delete_block b4: somebody has commented on the block',
          'insert_at_end the end of the doc: a cleanup may not open a second notes section',
        ],
      },
    });
    const offer = mount(f);
    offer.offer('m-1');
    goEl().click();
    await vi.waitFor(() => expect(reasonRows().length).toBe(3));
    // One row per RULE, commonest first — not one per edit, and not one per
    // block id: the ids are not something a reader can act on.
    expect(reasonRows()).toEqual([
      '3 edits — the document does not record the block as the note-taker’s own',
      '1 edit — a cleanup may not open a second notes section',
      '1 edit — somebody has commented on the block',
    ]);
    expect(reasonsEl().hidden).toBe(false);
    // And what to do about the commonest of them.
    expect(recoveryEl().hidden).toBe(false);
    expect(recoveryEl().textContent).toContain('Editing them yourself');
    // Still the offer it was: pressing again is allowed, because every one of
    // those rules is a fact about a document that is live.
    expect(goEl().disabled).toBe(false);
    expect(goEl().textContent).toBe('Try again');
  });

  it('reads a compose that never answered as a failure, not as nothing to do', async () => {
    // Seen on a replay of the 15 September meeting: "0 proposed, 0 applied, 0
    // refused (refused: compose-failed)". Read as counts alone that is a pass
    // with nothing to do; it is a model call that failed and wrote nothing.
    const f = stubFetch({ status: 409, body: { ok: false, reason: 'compose-failed' } });
    const offer = mount(f);
    offer.offer('m-1');
    goEl().click();
    await vi.waitFor(() =>
      expect(headlineEl().textContent).toBe(
        'The tidy-up could not run — the model did not answer.',
      ),
    );
    expect(recoveryEl().textContent).toContain('nothing runs it again on its own');
    expect(goEl().textContent).toBe('Try again');
    expect(goEl().disabled).toBe(false);
    expect(offerEl().hidden).toBe(false);
  });

  it('offers no retry for a refusal that would answer the same way for ever', async () => {
    const f = stubFetch({ status: 409, body: { ok: false, reason: 'no-composer' } });
    const offer = mount(f);
    offer.offer('m-1');
    goEl().click();
    await vi.waitFor(() => expect(headlineEl().textContent).toContain('no model key configured'));
    // Dead for this server — but the person may still leave, and the dialog
    // is still the thing they leave from.
    expect(goEl().disabled).toBe(true);
    expect(dismissEl().disabled).toBe(false);
    expect(offerEl().hidden).toBe(false);
  });

  it("clears the last pass's reasons before the next one runs", async () => {
    const f = deferredFetch();
    const offer = mount(f.impl);
    offer.offer('m-1');
    goEl().click();
    f.settle(0, {
      ok: true,
      changed: false,
      proposed: 1,
      refused: 1,
      refusals: ['delete_block b9: somebody has commented on the block'],
    });
    await vi.waitFor(() => expect(reasonRows().length).toBe(1));
    goEl().click();
    // While the second pass is on the wire nothing on screen may still be
    // explaining the first — it would read as this run's answer.
    await vi.waitFor(() => expect(headlineEl().textContent).toBe('Tidying up these notes…'));
    expect(reasonRows()).toEqual([]);
    expect(recoveryEl().hidden).toBe(true);
    f.settle(1, { ok: true, changed: true, touched: 3 });
    await vi.waitFor(() => expect(offerEl().hidden).toBe(true));
  });
});

/**
 * WHAT THE DIALOG LEADS WITH, AND WHAT IT LEAVES PRESSABLE.
 *
 * Four outcomes shipped with "Tidy up these notes?" at 17px full strength and
 * the sentence naming what had happened at 13px muted underneath — the
 * loudest text on screen was the one thing the reader had already answered.
 * These cases are the behaviour half of that fix: that the outcome IS the
 * loud line, that the dialog says which of its three states it is in so the
 * stylesheet can dress the answers, and that the controls left on screen are
 * the ones a person can still use.
 */
describe('what leads, and what is left to press', () => {
  it('asks the question, then says it is working, then names what happened', async () => {
    const f = deferredFetch();
    const offer = mount(f.impl);
    offer.offer('m-1');
    expect(headlineEl().textContent).toBe('Tidy up these notes?');
    expect(phase()).toBe('asking');
    // One loud line and no second one under it: the question does not stay on
    // screen competing with the news that answers it.
    expect(offerEl().querySelectorAll('.cleanup-offer-title')).toHaveLength(1);

    goEl().click();
    await vi.waitFor(() => expect(phase()).toBe('working'));
    expect(headlineEl().textContent).toBe('Tidying up these notes…');

    f.settle(0, {
      ok: true,
      changed: false,
      proposed: 2,
      refused: 2,
      refusals: [
        'delete_block b1: somebody has commented on the block',
        'replace_block b2: somebody has commented on the block',
      ],
    });
    await vi.waitFor(() => expect(phase()).toBe('reported'));
    // The outcome, in the line that was the question — and it is the dialog's
    // accessible name, so what it is called and what it says are one thing.
    expect(headlineEl().textContent).toBe(
      'Nothing changed — none of these edits could be made to the notes.',
    );
    const card = offerEl().querySelector('.cleanup-offer-card');
    expect(card?.getAttribute('aria-labelledby')).toBe(headlineEl().id);
    // Announced without the focus moving, since nothing else would say it.
    expect(headlineEl().getAttribute('aria-live')).toBe('polite');
  });

  it('stops saying "Not now" once the pass has run', async () => {
    const f = stubFetch({
      body: {
        ok: true,
        changed: false,
        proposed: 1,
        refused: 1,
        refusals: ['delete_block b1: somebody has commented on the block'],
      },
    });
    const offer = mount(f);
    offer.offer('m-1');
    expect(dismissEl().textContent).toBe('Not now');
    goEl().click();
    await vi.waitFor(() => expect(phase()).toBe('reported'));
    // "Not now" defers a question. By now it has been answered.
    expect(dismissEl().textContent).toBe('Close');
    expect(goLabel()).toBe('Try again');
  });

  it('leaves one live control, saying what it does, when nothing can be retried', async () => {
    // The pass read the meeting and found the notes finished. There is
    // nothing to press but the way out, so the way out is what is on screen —
    // a permanently dead "Tidy up" beside it is one more thing to weigh.
    const f = stubFetch({ body: { ok: true, changed: false, proposed: 0, refused: 0 } });
    const offer = mount(f);
    offer.offer('m-1');
    goEl().click();
    await vi.waitFor(() => expect(phase()).toBe('reported'));
    expect(goEl().hidden).toBe(true);
    expect(dismissEl().hidden).toBe(false);
    expect(dismissEl().disabled).toBe(false);
    expect(dismissEl().textContent).toBe('Close');
  });

  it('keeps the primary on a report that CAN be pressed again', async () => {
    // The control for the case above: removal belongs to `retry: false`, not
    // to every report. A reading in which the primary always goes fails here.
    const f = stubFetch({ status: 409, body: { ok: false, reason: 'compose-failed' } });
    const offer = mount(f);
    offer.offer('m-1');
    goEl().click();
    await vi.waitFor(() => expect(phase()).toBe('reported'));
    expect(goEl().hidden).toBe(false);
    expect(goEl().disabled).toBe(false);
    expect(goLabel()).toBe('Try again');
  });

  it('keeps Tab inside the dialog when the primary has been taken away', async () => {
    // The trap walks the answers that are actually stops. `report` hides and
    // disables the primary on one line, so the one live control is the only
    // stop, and Tab has to turn back onto it rather than leaving the card.
    const f = stubFetch({ body: { ok: true, changed: false, proposed: 0, refused: 0 } });
    const offer = mount(f);
    offer.offer('m-1');
    goEl().click();
    await vi.waitFor(() => expect(goEl().hidden).toBe(true));
    dismissEl().focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dismissEl());
  });

  it('brings the primary back for the next meeting', async () => {
    // The removal belongs to one reply, not to the mount.
    const f = stubFetch({ body: { ok: true, changed: false, proposed: 0, refused: 0 } });
    const offer = mount(f);
    offer.offer('m-1');
    goEl().click();
    await vi.waitFor(() => expect(goEl().hidden).toBe(true));
    offer.offer('m-2');
    expect(goEl().hidden).toBe(false);
    expect(goEl().disabled).toBe(false);
    expect(goLabel()).toBe('Tidy up');
    expect(dismissEl().textContent).toBe('Not now');
    expect(phase()).toBe('asking');
  });
});
