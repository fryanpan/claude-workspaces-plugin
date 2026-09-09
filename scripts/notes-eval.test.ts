import { describe, expect, test } from 'vitest';
/**
 * The eval's invented-link column, over a synthetic meeting.
 *
 * The real eval spends money and talks to a model, so what is checked here is
 * the COUNTING: a scripted composer that invents an address must show up in
 * the column, and one that cites what it was handed must not. Driven through
 * the same tick harness the eval drives, so the shape the column reads —
 * `shot.input` and `shot.composed` — is the shape the run really produces.
 *
 * Fictional throughout: Riverbend's board, example.com.
 */
import { createNotesTickHarness } from '../packages/server/test/notes-tick-harness.ts';
import { inventedLinkVerdict } from './notes-eval.ts';

const ROW = '/workspaces/w-riverbend?task=t-42';
const INVENTED = 'https://web.archive.org/web/2019/https://example.com/gate';

/** A one-tick meeting whose composer answers with `markdown`. */
async function runTick(
  markdown: string,
  notesBefore = '',
): Promise<ReturnType<typeof inventedLinkVerdict>> {
  const harness = createNotesTickHarness({
    doc: `## Meeting notes\n\n${notesBefore}`,
    workspaceId: 'w-riverbend',
    tasks: [{ id: 't-42', title: 'Riverbend gate moves before merge', status: 'todo' }],
    compose: (input) => [
      input.notesHeadingId === undefined
        ? { op: 'insert_at_end', markdown: `## Meeting notes\n\n${markdown}` }
        : { op: 'insert_under_heading', headingId: input.notesHeadingId, markdown },
    ],
  });
  const shot = await harness.speak({
    speaker: 'A',
    text: 'the Riverbend gate moves before merge, Devi to confirm',
  });
  return inventedLinkVerdict(shot, notesBefore);
}

describe('the invented-link column', () => {
  test('a composed link the tick was never given fails the column', async () => {
    const verdict = await runTick(`- Devi cited [the archive](${INVENTED}) on the gate.`);
    expect(verdict?.ok).toBe(false);
    expect(verdict?.detail).toContain('web.archive.org');
  });

  test('CONTROL: the row this tick actually named passes', async () => {
    const verdict = await runTick(`- [Riverbend gate moves before merge](${ROW}) — Devi confirms.`);
    expect(verdict).not.toBeNull();
    expect(verdict?.ok).toBe(true);
  });

  test('a tick that composed no link at all is not an example', async () => {
    expect(await runTick('- The gate moves before merge, Devi to confirm.')).toBeNull();
  });

  test('a citation the notes already carried is not counted against this tick', async () => {
    const verdict = await runTick(
      '- Still [the spec](https://example.com/riverbend/spec), unchanged.',
      '- Read [the spec](https://example.com/riverbend/spec).\n',
    );
    expect(verdict?.ok).toBe(true);
  });

  test('a tick whose compose never ran is not an example', () => {
    expect(inventedLinkVerdict({ composed: [] }, '')).toBeNull();
  });
});
