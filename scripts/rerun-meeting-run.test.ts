/**
 * The live spend cap, driven with a stub composer.
 *
 * THE MODEL IS STUBBED, always: this is the guard that stops a rerun that has
 * already started, and the only way to exercise it honestly is to hand it a
 * composer whose "usage" is a number this file chose. A test that called a
 * real one to find out what it billed would be the runaway spend the guard
 * exists to end.
 */
import { describe, expect, it } from 'vitest';
import type { NotesComposeInput, NotesComposer } from '../packages/server/src/meeting-notes.ts';
import type { NotesComposeMeasure } from '../packages/server/src/notes-timing.ts';
import { runFolderName } from './rerun-meeting-run.ts';
import { SpendCapReached, meteredComposer } from './rerun-meeting-spend.ts';

/** $25 of Opus output, so one call is a round number of dollars. */
const DOLLAR_OF_OPUS = {
  inputTokens: 0,
  outputTokens: 40_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** A composer that bills what it is told to and returns no edits. */
function billing(usd: number): NotesComposer {
  const scale = usd; // one dollar per unit, at the rate above
  return {
    name: 'stub',
    async compose(input) {
      input.measure?.({ model: 'claude-opus-5' });
      input.measure?.({
        usage: {
          ...DOLLAR_OF_OPUS,
          outputTokens: DOLLAR_OF_OPUS.outputTokens * scale,
        },
      });
      return [];
    },
  };
}

/** The composer only ever reads `measure` here; the rest of a tick's input is
 *  the pipeline's business and is exercised by the server suite. */
function tick(measure?: (m: NotesComposeMeasure) => void): NotesComposeInput {
  return { measure } as unknown as NotesComposeInput;
}

describe('meteredComposer', () => {
  it('adds up what each call billed and reports the running total', async () => {
    const seen: Array<[number, number]> = [];
    const metered = meteredComposer(billing(1), 100, (usd, calls) => seen.push([usd, calls]));
    await metered.compose(tick());
    await metered.compose(tick());
    expect(seen).toHaveLength(2);
    expect(seen[0]?.[0]).toBeCloseTo(1);
    expect(seen[1]?.[0]).toBeCloseTo(2);
    expect(seen[1]?.[1]).toBe(2);
  });

  it('refuses the NEXT compose once the ceiling is passed', async () => {
    const metered = meteredComposer(billing(3), 2, () => {});
    // The first call is allowed to finish: it has already been paid for, and
    // throwing its reply away would cost the money and lose the note too.
    await expect(metered.compose(tick())).resolves.toEqual([]);
    await expect(metered.compose(tick())).rejects.toThrow(SpendCapReached);
  });

  it('lets a run that stays under the ceiling keep going', async () => {
    const metered = meteredComposer(billing(0.5), 2, () => {});
    for (let i = 0; i < 3; i++) await expect(metered.compose(tick())).resolves.toEqual([]);
  });

  it('passes the measurements on to whoever else was listening', async () => {
    const onward: NotesComposeMeasure[] = [];
    const metered = meteredComposer(billing(1), 100, () => {});
    await metered.compose(tick((m) => onward.push(m)));
    expect(onward.some((m) => m.model === 'claude-opus-5')).toBe(true);
    expect(onward.some((m) => m.usage !== undefined)).toBe(true);
  });

  it('bills nothing for a call whose model it never saw', async () => {
    // An unpriced or unreported model must not be silently counted as free
    // spend that advances the cap — the report names it instead.
    const unnamed: NotesComposer = {
      name: 'stub',
      async compose(input) {
        input.measure?.({ usage: DOLLAR_OF_OPUS });
        return [];
      },
    };
    const spends: number[] = [];
    const metered = meteredComposer(unnamed, 0.001, (usd) => spends.push(usd));
    await expect(metered.compose(tick())).resolves.toEqual([]);
    await expect(metered.compose(tick())).resolves.toEqual([]);
    expect(spends).toEqual([]);
  });
});

describe('runFolderName', () => {
  it('sorts by time and carries no colons a filesystem would argue about', () => {
    const early = runFolderName(Date.UTC(2026, 8, 15, 9, 30, 0));
    const later = runFolderName(Date.UTC(2026, 8, 15, 11, 5, 0));
    expect(early < later).toBe(true);
    expect(early).not.toContain(':');
    expect(early.startsWith('rerun-')).toBe(true);
  });
});
