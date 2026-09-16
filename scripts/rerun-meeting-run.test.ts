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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { NotesMethod } from '../packages/core/src/notes-method.ts';
import type { NotesComposeInput, NotesComposer } from '../packages/server/src/meeting-notes.ts';
import type {
  TaskCaptureExtractor,
  TaskCaptureInput,
} from '../packages/server/src/meeting-task-capture.ts';
import type { NotesComposeMeasure } from '../packages/server/src/notes-timing.ts';
import type { ReplayInput, ReplayTarget } from './replay-meeting-lib.ts';
import type { RerunArgs } from './rerun-meeting-args.ts';
import { bySegment, checkStreams, scheduleEdit, streamsOf } from './rerun-meeting-feed.ts';
import type { RerunDeps } from './rerun-meeting-run.ts';
import {
  audioLengthMs,
  billedTotals,
  makeRunDir,
  methodReader,
  runFolderName,
  runRerun,
} from './rerun-meeting-run.ts';
import { SpendCapReached, createSpendMeter } from './rerun-meeting-spend.ts';
import { engineFor, requireCapture } from './rerun-meeting.ts';

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

  it('refuses the next compose when a call billed under a model it cannot price', async () => {
    // `dollars()` answers 0 for a model this build has never heard of, so a
    // run on a new model family would hold its total at zero while the vendor
    // billed. The ceiling fails CLOSED: the call in flight is paid for, and
    // the next one is refused.
    const unpriced: NotesComposer = {
      name: 'stub',
      async compose(input) {
        input.measure?.({ model: 'claude-experimental-9' });
        input.measure?.({ usage: DOLLAR_OF_OPUS });
        return [];
      },
    };
    const spends: number[] = [];
    const meter = createSpendMeter(1000, (usd: number) => spends.push(usd));
    const composer = meter.composer(unpriced);
    await expect(composer.compose(tick())).resolves.toEqual([]);
    await expect(composer.compose(tick())).rejects.toThrow(/claude-experimental-9 has no price/);
    // Nothing was booked against the ceiling, because nothing could be.
    expect(spends).toEqual([]);
    expect(meter.calls).toBe(0);
  });

  it('tells the run to stop the moment a call cannot be priced', async () => {
    // Refusing the next compose is not enough on its own: the pipeline catches
    // a failed compose and keeps ticking, so the capture pass would bill for
    // the rest of the recording under a ceiling nothing can enforce.
    const unpriced: NotesComposer = {
      name: 'stub',
      async compose(input) {
        input.measure?.({ model: 'claude-experimental-9', usage: DOLLAR_OF_OPUS });
        return [];
      },
    };
    const stopped: string[] = [];
    const meter = createSpendMeter(
      1000,
      () => {},
      (model) => stopped.push(model),
    );
    const composer = meter.composer(unpriced);
    await composer.compose(tick());
    expect(stopped).toEqual(['claude-experimental-9']);
    // Once only: a run is stopped, not stopped again on every later tick.
    await expect(composer.compose(tick())).rejects.toThrow(SpendCapReached);
    expect(stopped).toEqual(['claude-experimental-9']);
  });

  it('says nothing to the run while every call can be priced', async () => {
    const stopped: string[] = [];
    const meter = createSpendMeter(
      1000,
      () => {},
      (model) => stopped.push(model),
    );
    await meter.composer(billingComposer(1)).compose(tick());
    expect(stopped).toEqual([]);
  });

  it('refuses just as hard when the call never named a model at all', async () => {
    const unnamed: NotesComposer = {
      name: 'stub',
      async compose(input) {
        input.measure?.({ usage: DOLLAR_OF_OPUS });
        return [];
      },
    };
    const meter = createSpendMeter(1000, () => {});
    const composer = meter.composer(unnamed);
    await expect(composer.compose(tick())).resolves.toEqual([]);
    await expect(composer.compose(tick())).rejects.toThrow(SpendCapReached);
    expect(meter.calls).toBe(0);
  });

  it('keeps going for a model it does know, at a ceiling far above it', async () => {
    // The control: the refusal above is about the PRICE LIST, not about
    // measuring at all.
    const meter = createSpendMeter(1000, () => {});
    const composer = meter.composer(billingComposer(1));
    await expect(composer.compose(tick())).resolves.toEqual([]);
    await expect(composer.compose(tick())).resolves.toEqual([]);
    expect(meter.calls).toBe(2);
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

/** A recording of `n` segments, each holding the named streams. */
function target(segments: Array<{ n: number; streams: string[] }>): ReplayTarget {
  const inputs: ReplayInput[] = [];
  for (const seg of segments) {
    for (const stream of seg.streams) {
      inputs.push({
        segment: seg.n,
        stream,
        path: `/m/segment-${seg.n}-${stream}.pcm`,
        sampleRate: 16_000,
        startedAt: 0,
        mode: 'conversation',
        source: 'mic',
      });
    }
  }
  return { dir: '/m', docId: 'd-1', docName: 'd-1', inputs };
}

describe('a recording that kept two streams', () => {
  it("groups a segment's streams together, in segment order", () => {
    const grouped = bySegment(
      target([
        { n: 2, streams: ['mic', 'system'] },
        { n: 1, streams: ['mic'] },
      ]).inputs,
    );
    expect(grouped.map(([n, inputs]) => [n, inputs.map((i) => i.stream)])).toEqual([
      [1, ['mic']],
      [2, ['mic', 'system']],
    ]);
  });

  it('names the streams it holds, mic first, as the capture opens them', () => {
    expect(streamsOf(target([{ n: 1, streams: ['system', 'mic'] }]))).toEqual(['mic', 'system']);
    expect(streamsOf(target([{ n: 1, streams: ['mic'] }]))).toEqual(['mic']);
  });

  it('is as long as the meeting, not as long as its files added up', () => {
    // 32,000 bytes is one second of 16 kHz PCM16. Two streams of a segment are
    // the same minute recorded twice: summing them would cost a two-stream
    // meeting at double its length and refuse runs that fit.
    const two = target([
      { n: 1, streams: ['mic', 'system'] },
      { n: 2, streams: ['mic'] },
    ]);
    const sizes: Record<string, number> = {
      '/m/segment-1-mic.pcm': 32_000,
      '/m/segment-1-system.pcm': 64_000,
      '/m/segment-2-mic.pcm': 32_000,
    };
    expect(audioLengthMs(two, (p) => sizes[p] as number)).toBe(3000);
  });
});

describe('billedTotals', () => {
  it('adds what was billed after the meeting summary was struck', () => {
    // The tidy-up runs after the stop, through the same metered composer. A
    // report that took the summary alone left its call out of a figure that
    // had already helped decide whether the cap fired.
    expect(
      billedTotals({ usd: 0.05, calls: 30 }, { usd: 0.048, calls: 30 }, { usd: 0.061, calls: 31 }),
    ).toEqual({ usd: 0.05 + 0.013, calls: 31 });
  });

  it('falls back to the meter when the meeting recorded no spend of its own', () => {
    expect(billedTotals(undefined, { usd: 0.02, calls: 4 }, { usd: 0.03, calls: 5 })).toEqual({
      usd: 0.03,
      calls: 5,
    });
  });
});

describe('makeRunDir', () => {
  it('gives a second run of the same second a folder of its own', () => {
    // Two comparison runs against one --out is the ordinary way this is used,
    // and a recursive create would have let the second write its notes, its
    // report and its log over the first one's in silence.
    const made = new Set<string>();
    const make = (dir: string): void => {
      if (made.has(dir)) {
        const err = new Error('exists') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      made.add(dir);
    };
    const at = Date.UTC(2026, 8, 15, 9, 30, 0);
    const first = makeRunDir('/out', at, make);
    const second = makeRunDir('/out', at, make);
    const third = makeRunDir('/out', at, make);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(first).toBe('/out/rerun-20260915T093000Z');
    expect(second).toBe('/out/rerun-20260915T093000Z-2');
    expect(third).toBe('/out/rerun-20260915T093000Z-3');
  });

  it('lets any other failure through rather than looping on it', () => {
    const make = (): never => {
      const err = new Error('read-only') as NodeJS.ErrnoException;
      err.code = 'EROFS';
      throw err;
    };
    expect(() => makeRunDir('/out', 0, make)).toThrow('read-only');
  });
});

describe('the mock engine on a two-stream recording', () => {
  const args = (mockScript?: string): RerunArgs =>
    ({
      target: '/m',
      method: 'original',
      engine: 'mock',
      doc: 'empty',
      out: '/out',
      spendUsd: 1,
      chunkMs: 20,
      port: 0,
      keep: false,
      engineSpendOk: false,
      ...(mockScript !== undefined ? { mockScript } : {}),
    }) as RerunArgs;

  it('refuses one supplied script across two streams', () => {
    // The mock starts the script at index zero in every session, so both
    // sides of the call would say all of it and every idea count twice.
    expect(() =>
      engineFor(args('/m/script.json'), target([{ n: 1, streams: ['mic', 'system'] }])),
    ).toThrow(/--mock-script cannot drive mic \+ system/);
  });

  it('leaves the one-stream case, and its own default script, alone', () => {
    expect(engineFor(args(), target([{ n: 1, streams: ['mic', 'system'] }])).name).toBeTruthy();
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

describe('a recording on a stream the capture cannot open', () => {
  const on = (stream: string): ReplayTarget => target([{ n: 1, streams: [stream] }]);

  it('is refused by name, rather than replayed as microphone audio', () => {
    // The resolver takes any `segment-N-<stream>.pcm`. An unknown name used to
    // be dropped from `streamsOf` and then fed anyway — untagged — so its
    // words arrived under the microphone's source and the report described a
    // meeting whose sides were not the ones on disk.
    expect(() => checkStreams(on('screen'))).toThrow(
      /cannot open: screen \(segment-1-screen.pcm\)/,
    );
  });

  it('lets the two the capture does open through', () => {
    expect(() => checkStreams(on('mic'))).not.toThrow();
    expect(() => checkStreams(on('system'))).not.toThrow();
  });
});

describe('an edit that lands in the last seconds of the recording', () => {
  it('is tracked as a request, so the stop frame cannot overtake it', async () => {
    // The race this closes: the timer fires while the last chunks are still
    // going out, `stop` is sent, and the at-stop compose reads a document the
    // edit has not reached — with the log line arriving afterwards to say it
    // was applied.
    vi.useFakeTimers();
    try {
      const applied: Array<Promise<void>> = [];
      let finish: (() => void) | undefined;
      const post = (): Promise<unknown> =>
        new Promise<void>((resolve) => {
          finish = resolve;
        });
      const feed = {
        base: 'http://x',
        ws: 'w',
        docId: 'd',
        log: () => {},
      } as unknown as Parameters<typeof scheduleEdit>[0];
      scheduleEdit(feed, { atMs: 1_000, find: 'a', replace: 'b' }, applied, post);
      expect(applied).toHaveLength(0);
      vi.advanceTimersByTime(1_000);
      expect(applied).toHaveLength(1);

      let settled = false;
      void applied[0]?.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false); // still in flight — stopping here loses it
      finish?.();
      await applied[0];
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the spoken-ask capture pass', () => {
  it('has to exist, because the estimate and the ceiling both count it', () => {
    // `createHaikuTaskCaptureExtractor` answers null with no key, or with
    // CW_MEETING_TASKS off. Passed through, it turns off one of the two
    // billed passes while the run still pays for the whole recording.
    expect(() => requireCapture(null)).toThrow(/capture pass could not be built/);
  });

  it('is handed straight back when it is there', () => {
    const extractor = { name: 'stub', extract: async () => [] } as unknown as TaskCaptureExtractor;
    expect(requireCapture(extractor)).toBe(extractor);
  });
});

describe('a --compare that names nothing readable', () => {
  /** A one-segment recording on disk, so the run gets as far as it can get
   *  before anything bills. */
  function recording(): ReplayTarget {
    const dir = mkdtempSync(join(tmpdir(), 'cw-rerun-compare-guard-'));
    const path = join(dir, 'segment-1-mic.pcm');
    writeFileSync(path, Buffer.alloc(32_000));
    return {
      dir,
      docId: 'd-riverbend',
      docName: 'Riverbend ferry review',
      inputs: [
        {
          segment: 1,
          stream: 'mic',
          path,
          sampleRate: 16_000,
          startedAt: 0,
          mode: 'conversation',
          source: 'mic',
        },
      ],
    };
  }

  it('is refused before the replay, not after it has billed for one', async () => {
    // The refusal that matters is the one that happens before the money. A
    // typo used to surface after the whole recording had been replayed, which
    // spends the ceiling and then writes no report at all.
    const reached: string[] = [];
    await expect(
      runRerun(
        {
          target: 'x',
          method: 'original',
          engine: 'mock',
          doc: 'empty',
          out: join(tmpdir(), 'cw-rerun-never'),
          spendUsd: 50,
          chunkMs: 20,
          port: 0,
          keep: false,
          engineSpendOk: false,
          compare: join(tmpdir(), 'cw-no-such-rerun-folder'),
        } satisfies RerunArgs,
        recording(),
        { shape: 'empty', markdown: '', edits: [] },
        {
          composer: () => {
            reached.push('composer');
            throw new Error('the note-taker must not be built');
          },
          transcription: {
            name: 'mock',
            open: () => {
              reached.push('engine');
              throw new Error('the engine must not open');
            },
          } as unknown as RerunDeps['transcription'],
          log: () => {},
        },
      ),
    ).rejects.toThrow(/--compare/);
    expect(reached).toEqual([]);
  });
});
