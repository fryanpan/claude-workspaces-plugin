/**
 * The live spend cap, driven with a stub composer and a stub capture pass.
 *
 * THE MODEL IS STUBBED, always: this is the guard that stops a rerun that has
 * already started, and the only way to exercise it honestly is to hand it
 * passes whose "usage" is a number this file chose. A test that called a real
 * one to find out what it billed would be the runaway spend the guard exists
 * to end.
 *
 * BOTH PASSES, because the capture half was the hole. A meeting pays for the
 * compose and for the spoken-ask capture on every tick; a cap that watched
 * only the composer let a run reach about twice the ceiling it was given.
 */
import { describe, expect, it } from 'vitest';
import type { NotesMethod } from '../packages/core/src/notes-method.ts';
import type { NotesComposeInput, NotesComposer } from '../packages/server/src/meeting-notes.ts';
import type {
  TaskCaptureExtractor,
  TaskCaptureInput,
} from '../packages/server/src/meeting-task-capture.ts';
import type { NotesComposeMeasure } from '../packages/server/src/notes-timing.ts';
import { methodReader, runFolderName } from './rerun-meeting-run.ts';
import { SpendCapReached, createSpendMeter } from './rerun-meeting-spend.ts';

/** Opus bills $25 per million output tokens, so this is one dollar of it. */
const DOLLAR_OF_OPUS = {
  inputTokens: 0,
  outputTokens: 40_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const usageFor = (usd: number): typeof DOLLAR_OF_OPUS => ({
  ...DOLLAR_OF_OPUS,
  outputTokens: DOLLAR_OF_OPUS.outputTokens * usd,
});

/** A note-taker that bills what it is told to and returns no edits. */
function billingComposer(usd: number): NotesComposer {
  return {
    name: 'stub',
    async compose(input) {
      input.measure?.({ model: 'claude-opus-5' });
      input.measure?.({ usage: usageFor(usd) });
      return [];
    },
  };
}

/** A capture pass that bills what it is told to and captures nothing. Haiku
 *  bills $5 per million output tokens, a fifth of Opus. */
function billingExtractor(usd: number): TaskCaptureExtractor {
  return {
    name: 'stub-capture',
    async extract(input) {
      input.measure?.({ model: 'claude-haiku-4-5', usage: usageFor(usd * 5) });
      return [];
    },
  };
}

/** The passes only ever read `measure` here; the rest of a tick's input is the
 *  pipeline's business and is exercised by the server suite. */
function tick(measure?: (m: NotesComposeMeasure) => void): NotesComposeInput {
  return { measure } as unknown as NotesComposeInput;
}
function captureTick(): TaskCaptureInput {
  return {} as unknown as TaskCaptureInput;
}

describe('the spend meter', () => {
  it('adds up what each compose billed and reports the running total', async () => {
    const seen: Array<[number, number]> = [];
    const meter = createSpendMeter(100, (usd: number, calls: number) => seen.push([usd, calls]));
    const composer = meter.composer(billingComposer(1));
    await composer.compose(tick());
    await composer.compose(tick());
    expect(seen).toHaveLength(2);
    expect(seen[0]?.[0]).toBeCloseTo(1);
    expect(seen[1]?.[0]).toBeCloseTo(2);
    expect(seen[1]?.[1]).toBe(2);
    expect(meter.totalUsd).toBeCloseTo(2);
    expect(meter.calls).toBe(2);
  });

  it('refuses the NEXT compose once the ceiling is passed', async () => {
    const meter = createSpendMeter(2, () => {});
    const composer = meter.composer(billingComposer(3));
    // The first call is allowed to finish: it has already been paid for, and
    // throwing its reply away would cost the money and lose the note too.
    await expect(composer.compose(tick())).resolves.toEqual([]);
    await expect(composer.compose(tick())).rejects.toThrow(SpendCapReached);
  });

  it('lets a run that stays under the ceiling keep going', async () => {
    const meter = createSpendMeter(2, () => {});
    const composer = meter.composer(billingComposer(0.5));
    for (let i = 0; i < 3; i++) await expect(composer.compose(tick())).resolves.toEqual([]);
  });

  it('counts the capture pass into the same total', async () => {
    const meter = createSpendMeter(100, () => {});
    await meter.extractor(billingExtractor(1)).extract(captureTick());
    expect(meter.totalUsd).toBeCloseTo(1);
    expect(meter.calls).toBe(1);
  });

  it('reaches the ceiling on capture spend alone, and refuses the next compose', async () => {
    // The hole this guard had: the capture pass bills on every tick, and a
    // meter that watched the composer alone let a run reach about twice the
    // ceiling its operator named before anything refused.
    const meter = createSpendMeter(2, () => {});
    const composer = meter.composer(billingComposer(0));
    await meter.extractor(billingExtractor(3)).extract(captureTick());
    await expect(composer.compose(tick())).rejects.toThrow(SpendCapReached);
  });

  it('passes the measurements on to whoever else was listening', async () => {
    const onward: NotesComposeMeasure[] = [];
    const meter = createSpendMeter(100, () => {});
    await meter.composer(billingComposer(1)).compose(tick((m) => onward.push(m)));
    expect(onward.some((m) => m.model === 'claude-opus-5')).toBe(true);
    expect(onward.some((m) => m.usage !== undefined)).toBe(true);
  });

  it('bills nothing for a call whose model it never named', async () => {
    // An unreported model must not be silently counted as free spend that
    // advances the cap — the report names it instead.
    const unnamed: NotesComposer = {
      name: 'stub',
      async compose(input) {
        input.measure?.({ usage: DOLLAR_OF_OPUS });
        return [];
      },
    };
    const spends: number[] = [];
    const meter = createSpendMeter(0.001, (usd: number) => spends.push(usd));
    const composer = meter.composer(unnamed);
    await expect(composer.compose(tick())).resolves.toEqual([]);
    await expect(composer.compose(tick())).resolves.toEqual([]);
    expect(spends).toEqual([]);
    expect(meter.calls).toBe(0);
  });
});

describe('methodReader', () => {
  it('hands the composer the method the doc asks for, not a constant', () => {
    // `--method` reaches the note-taker through this read and no other, so a
    // reader that answered a constant would run the original composer for all
    // three methods under a report heading naming the one that was asked for.
    const lines: string[] = [];
    const reader = methodReader(
      '/data',
      (l) => lines.push(l),
      () => 'ledger-opus',
    );
    expect(reader('d-1')).toBe('ledger-opus');
    expect(lines).toEqual(['note-taker in force: ledger-opus']);
  });

  it('says so once, and again only when the method changes mid-meeting', () => {
    const lines: string[] = [];
    const methods: NotesMethod[] = ['original', 'original', 'ledger-haiku', 'ledger-haiku'];
    let i = 0;
    const reader = methodReader(
      '/data',
      (l) => lines.push(l),
      () => methods[i++] as NotesMethod,
    );
    for (let n = 0; n < methods.length; n++) reader('d-1');
    expect(lines).toEqual(['note-taker in force: original', 'note-taker in force: ledger-haiku']);
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
