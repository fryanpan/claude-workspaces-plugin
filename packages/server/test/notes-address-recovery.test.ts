/**
 * A tick whose edits miss must not lose what was said.
 *
 * THE MEASURED FAILURE. A tick's edits are addressed by the model, and when
 * that address is one the doc cannot honour the applier fails the edit — the
 * note it carried is the only copy of those words, so it is gone. The
 * pipeline recovers ONE such tick: the turns carry and the next compose notes
 * them again (`meeting-notes.ts`, `retryAfterFailure`). It cannot recover a
 * REPEATING one, because `retriedFailure` is cleared only by a success, so
 * the same wrong id tick after tick loses every note after the first — the
 * final pass at `end()` included, with a `console.error` line the only trace.
 *
 * Reproduced here before the fix, on the real write path: the second test
 * below ended with the tick-1 note and nothing else, three turns of speech
 * gone. That is the criterion that had to be FALSE first.
 *
 * WHY `not-a-heading` IS THE SHAPE SCRIPTED. The production log's sentence —
 * "every edit named a block that is no longer in the doc" — is a fallback
 * string, not a reading of what failed, and this is the failure it describes
 * wrongly: the block IS in the doc, it is a bullet rather than a heading. The
 * prompt lists bullets and headings side by side with their ids and asks for
 * a note "under the heading of its topic", so naming the bullet is a mistake
 * the prompt invites. `unknown-block` is the other shape and is covered too.
 *
 * All fixtures are invented place names. The repo is public.
 */
import { describe, expect, test } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

/** What a meeting says, one turn per tick. */
const SPOKEN = [
  'the survey starts on the first',
  'the pier needs a permit before any work begins',
  'the budget is signed off',
  'the ferry timetable changes in March',
] as const;

/**
 * A meeting whose composer writes the words it is HANDED, mis-addressing the
 * ticks in `bad`.
 *
 * Writing `input.tick.turns` rather than a fixed string is what makes this a
 * test of loss rather than of the script: a turn that carried into a later
 * tick is composed again there, so anything missing at the end is missing
 * because the pipeline lost it.
 */
async function meeting(
  bad: ReadonlySet<number>,
  address: (outline: readonly prose.OutlineEntry[]) => string,
): Promise<{ doc: string; skips: number }> {
  let skips = 0;
  const h = createNotesTickHarness({
    doc: '# Harborlight survey\n',
    compose: (input, tick) => {
      const markdown = input.tick.turns.map((t) => `- ${t.text}`).join('\n');
      if (markdown.length === 0) return [];
      if (!bad.has(tick)) return addNotes(input, markdown);
      return [{ op: 'insert_under_heading', headingId: address(input.outline), markdown }];
    },
  });
  for (const line of SPOKEN) await h.speak(line);
  await h.end();
  skips = h.errors.filter((e) => e.includes('doc write skipped')).length;
  return { doc: h.markdown(), skips };
}

/** The id of a block that is real and is not a heading — what a model reaches
 *  for when it means "under this topic" and takes the bullet's row. */
const aBullet = (outline: readonly prose.OutlineEntry[]): string =>
  outline.find((e) => e.kind === 'listItem')?.id ?? 'b-none';

const gone = (): string => 'b-gone';

describe('a tick whose note is addressed to a block the doc cannot honour', () => {
  test('keeps its words when the mistake happens once', async () => {
    const { doc, skips } = await meeting(new Set([2]), aBullet);
    expect(doc).toContain('the pier needs a permit');
    // The note landed in the section, so nothing was carried and no write was
    // reported as skipped. Before the repair this read 2.
    expect(skips).toBe(0);
  });

  // THE ONE THAT USED TO LOSE A MEETING. Every tick from the second on names
  // the same wrong id, which is what a model does when the prompt and the doc
  // shape have not changed. Before the repair this doc held the tick-1 note
  // and nothing else.
  test('keeps every word when the mistake REPEATS to the end of the meeting', async () => {
    const { doc, skips } = await meeting(new Set([2, 3, 4, 5, 6]), aBullet);
    for (const line of SPOKEN) expect(doc).toContain(line);
    expect(skips).toBe(0);
  });

  test('keeps its words when the block named is gone rather than not a heading', async () => {
    const { doc } = await meeting(new Set([2, 3, 4, 5, 6]), gone);
    for (const line of SPOKEN) expect(doc).toContain(line);
  });

  // THE NOTES STAY ONE SECTION. A recovered note is written under the
  // meeting's own heading, so recovering one must never be the thing that
  // opens a second `Meeting notes` — which is the failure mode that strands
  // everything written before it (`notes-edit-guard.ts` RULE 1).
  test('writes the recovered note under the meeting’s existing section', async () => {
    const h = createNotesTickHarness({
      doc: '# Harborlight survey\n',
      compose: (input, tick) => {
        const markdown = input.tick.turns.map((t) => `- ${t.text}`).join('\n');
        if (markdown.length === 0) return [];
        if (tick === 1) return addNotes(input, markdown);
        return [{ op: 'insert_under_heading', headingId: aBullet(input.outline), markdown }];
      },
    });
    for (const line of SPOKEN) await h.speak(line);
    await h.end();
    expect(h.countHeadings('Meeting notes')).toBe(1);
    for (const line of SPOKEN) expect(h.notes()).toContain(line);
  });
});

describe('what the repair does not touch', () => {
  // A REGROUP THAT MOVED NOTHING IS STILL NOT A FAILED WRITE. The repair
  // reads the same verdicts `failedCarryingWords` does, and a batch of moves
  // must come out of it unchanged — otherwise a `nest_blocks` that found
  // nothing to nest would start writing a note.
  test('a batch of moves that all failed writes no note', async () => {
    const h = createNotesTickHarness({
      doc: '# Harborlight survey\n',
      compose: (input, tick) => {
        const markdown = input.tick.turns.map((t) => `- ${t.text}`).join('\n');
        if (markdown.length === 0) return [];
        if (tick !== 2) return addNotes(input, markdown);
        const lead = input.outline.find((e) => e.kind === 'listItem');
        return [{ op: 'nest_blocks', leadBlockId: lead?.id ?? 'b-1', blockIds: ['b-gone'] }];
      },
    });
    for (const line of SPOKEN) await h.speak(line);
    await h.end();
    // NOTHING IS INVENTED FROM THE MOVE, and nothing is reported as a failed
    // write. Tick 2's own speech is absent because the script answered it
    // with a move and no note — a composer that writes nothing about a turn
    // is a notes-quality question the idea ledger already counts, and it is
    // not this module's to answer. What matters here is that a repair did
    // not conjure a note out of an edit that carried no words.
    expect(
      h
        .notes()
        .split('\n')
        .filter((l) => l.trim().length > 0),
    ).toHaveLength(3);
    expect(h.errors.filter((e) => e.includes('doc write skipped'))).toHaveLength(0);
    for (const line of [SPOKEN[0], SPOKEN[2], SPOKEN[3]]) expect(h.markdown()).toContain(line);
  });
});
