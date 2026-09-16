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
  mount,
  noteEl,
  offerEl,
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
      expect(noteEl().textContent).toBe('The tidy-up could not run — the model did not answer.'),
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
    await vi.waitFor(() => expect(noteEl().textContent).toContain('no model key configured'));
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
    await vi.waitFor(() => expect(noteEl().textContent).toBe('Tidying up these notes…'));
    expect(reasonRows()).toEqual([]);
    expect(recoveryEl().hidden).toBe(true);
    f.settle(1, { ok: true, changed: true, touched: 3 });
    await vi.waitFor(() => expect(offerEl().hidden).toBe(true));
  });
});
