/**
 * The gate's arithmetic, which is the part of `notes-eval-ideas.ts` that
 * decides whether a push is red.
 *
 * The model halves — listing the ideas, judging which survived — are not
 * testable without a network and are not tested here. What IS testable is
 * every way the verdict can be wrong while looking right: a rate computed off
 * an empty sample, a partial judge reply scored as loss, and a gate that
 * passes because it measured nothing.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type NotesEvalFixture } from './notes-eval-fixtures.ts';
import {
  MIN_GATED_IDEAS,
  type MeetingIdeaRate,
  TARGET_LOST_IDEA_RATE,
  buildMeetingTruth,
  judgeCarried,
  ratchetLostIdeaBar,
  rateOf,
  readLostIdeaBar,
  reportIdeaRates,
} from './notes-eval-ideas.ts';

const row = (meeting: string, ideas: number, lost: number): MeetingIdeaRate => ({
  meeting,
  ideas,
  lost,
  unjudged: 0,
  examples: [],
});

/**
 * Run the report with its console silenced, and give back the exit code.
 * The bar is the row's target, injected, so these runs read the same on the
 * day the ratchet reaches it as they do today.
 */
function verdict(rows: MeetingIdeaRate[], gate: boolean): number {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return reportIdeaRates(rows, gate, true, TARGET_LOST_IDEA_RATE);
  } finally {
    log.mockRestore();
  }
}

/** Every line the report printed, for the runs that are about what it says. */
function printed(rows: MeetingIdeaRate[], quote: boolean): string {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.join(' '));
  });
  try {
    reportIdeaRates(rows, false, quote);
  } finally {
    log.mockRestore();
  }
  return lines.join('\n');
}

describe('what the report is allowed to print', () => {
  const secret = 'Naida wants the budget moved to the second quarter';
  const withExample = (): MeetingIdeaRate[] => [
    { meeting: 'm-private-1', ideas: 200, lost: 1, unjudged: 0, examples: [`tick 3: ${secret}`] },
  ];

  it('withholds the example text when the corpus is private', () => {
    // An example IS a line of somebody's meeting, restated. The private half
    // of this corpus is reported as counts, rates and ids — so the text must
    // not reach a log file, a CI transcript or a scrollback.
    const out = printed(withExample(), false);
    expect(out).not.toContain(secret);
    expect(out).toContain('m-private-1');
    expect(out).toContain('1 idea(s) reached no note');
  });

  it('still prints the examples for the corpus that is in this repo', () => {
    // The negative control: withholding everywhere would pass the test above
    // while making the in-repo run useless to read.
    expect(printed(withExample(), true)).toContain(secret);
  });
});

describe('the lost-idea rate', () => {
  it('is loss over ideas, and zero when nothing was measured', () => {
    expect(rateOf({ ideas: 100, lost: 4 })).toBeCloseTo(0.04);
    expect(rateOf({ ideas: 0, lost: 0 })).toBe(0);
  });

  it('passes under the bar and fails over it, on the WHOLE corpus', () => {
    // Four in a hundred passes; six fails. And the verdict is the overall
    // rate, not the worst meeting: a short meeting that lost one idea of
    // three must not fail a corpus that is otherwise clean.
    expect(verdict([row('a', 200, 8)], true)).toBe(0);
    expect(verdict([row('a', 200, 12)], true)).toBe(1);
    expect(verdict([row('a', 200, 2), row('b', 3, 1)], true)).toBe(0);
  });

  it('reports without gating on a sample too thin to hold the bar', () => {
    // The CI smoke slice is three ticks of one meeting. One judgement call
    // about one bullet is twelve per cent of eight ideas, and a gate that
    // goes red on that gets turned off rather than read.
    expect(verdict([row('a', 8, 8)], true)).toBe(0);
    expect(verdict([row('a', MIN_GATED_IDEAS, MIN_GATED_IDEAS)], true)).toBe(1);
  });

  it('fails a gated run that measured nothing at all', () => {
    // The failure this whole change is about, in miniature: a check that
    // cannot fail reads exactly like a check that passed. No ground truth
    // means no verdict, and no verdict is not a pass.
    expect(verdict([], true)).toBe(1);
    // Ungated, the same absence is a report and nothing more.
    expect(verdict([], false)).toBe(0);
  });

  it('never fails an ungated run, however bad the rate', () => {
    expect(verdict([row('a', 10, 10)], false)).toBe(0);
  });

  it('states the bar the row asked for, and gates on the ratcheted one', () => {
    expect(TARGET_LOST_IDEA_RATE).toBe(0.05);
    const bar = readLostIdeaBar();
    expect(bar).toBeGreaterThanOrEqual(TARGET_LOST_IDEA_RATE);
    expect(bar).toBeLessThanOrEqual(0.41);
  });
});

describe('the ratchet', () => {
  const baseline = (rate: number): string => {
    const dir = mkdtempSync(join(tmpdir(), 'notes-eval-bar-'));
    const path = join(dir, 'baseline.json');
    writeFileSync(path, JSON.stringify({ maxLostIdeaRate: rate, measured: 'test', target: 0.05 }));
    return path;
  };
  const stored = (path: string): number =>
    (JSON.parse(readFileSync(path, 'utf8')) as { maxLostIdeaRate: number }).maxLostIdeaRate;

  it('reads the bar from the baseline file', () => {
    expect(readLostIdeaBar(baseline(0.3))).toBe(0.3);
  });

  it('refuses a baseline that is not a rate', () => {
    const path = baseline(0.3);
    writeFileSync(path, JSON.stringify({ maxLostIdeaRate: 'lots' }));
    expect(() => readLostIdeaBar(path)).toThrow(/maxLostIdeaRate/);
  });

  it('lowers the bar to a better run, rounded up so the run itself still passes', () => {
    const path = baseline(0.41);
    expect(ratchetLostIdeaBar(0.3141, 'better', path)).toBe(0.315);
    expect(stored(path)).toBe(0.315);
  });

  it('never raises the bar, whatever the run measured', () => {
    const path = baseline(0.3);
    expect(ratchetLostIdeaBar(0.45, 'worse', path)).toBe(0.3);
    expect(stored(path)).toBe(0.3);
  });

  it('stops at the target and goes no lower', () => {
    const path = baseline(0.1);
    expect(ratchetLostIdeaBar(0.01, 'great', path)).toBe(TARGET_LOST_IDEA_RATE);
    expect(stored(path)).toBe(TARGET_LOST_IDEA_RATE);
  });

  it('gates on the injected bar', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(reportIdeaRates([row('a', 200, 60)], true, true, 0.41)).toBe(0);
      expect(reportIdeaRates([row('a', 200, 60)], true, true, 0.05)).toBe(1);
    } finally {
      log.mockRestore();
    }
  });
});

/**
 * A ground truth is written once and then left alone, so a build that got a
 * short answer out of the network freezes that gap in permanently.
 */
describe('building a meeting ground truth', () => {
  const fixture = (ticks: number): NotesEvalFixture => ({
    meeting: 'FIC001',
    corpus: 'fictional',
    licence: 'none',
    source: 'invented for this test',
    window: { fromSeconds: 0, seconds: 60 },
    board: [],
    ticks: Array.from({ length: ticks }, (_, i) => ({
      turns: [{ speaker: 'Robin', text: `We should ship thing ${i + 1}.` }],
    })),
  });

  it('lists every tick when every call answers', async () => {
    const built = await buildMeetingTruth(
      fixture(3),
      async (t) => [t.trim()],
      () => '2026-01-01T00:00:00.000Z',
    );
    expect('truth' in built).toBe(true);
    if (!('truth' in built)) return;
    expect(built.truth.ticks.map((t) => t.tick)).toEqual([1, 2, 3]);
    expect(built.truth.meeting).toBe('FIC001');
  });

  it('hands back the unreadable ticks instead of a short list', async () => {
    const built = await buildMeetingTruth(fixture(4), async (t) =>
      t.includes('thing 2') || t.includes('thing 4') ? null : [t.trim()],
    );
    expect('truth' in built).toBe(false);
    if ('truth' in built) return;
    expect(built.unreadable).toEqual([2, 4]);
  });

  it('is not fooled by a tick that legitimately held no ideas', async () => {
    // An empty list is an ANSWER — that tick was read and contained nothing.
    // Only `null`, the unread call, may stop a build.
    const built = await buildMeetingTruth(fixture(3), async (t) =>
      t.includes('thing 2') ? [] : [t.trim()],
    );
    expect('truth' in built).toBe(true);
    if (!('truth' in built)) return;
    expect(built.truth.ticks.map((t) => t.tick)).toEqual([1, 3]);
  });
});

/**
 * The judge answers one row per idea. A reply that answers the same idea
 * twice reaches the expected total while leaving another idea unanswered,
 * and that idea then scores false — lost — on a verdict nobody gave.
 */
describe('reading the judge reply', () => {
  const cred = { kind: 'key', value: 'test-not-a-real-key' } as const;
  const ideas = ['the export drops the range', 'the invoice rounds down', 'we ship Tuesday'];

  /** A judge that replies with exactly these rows. */
  function judgeReplying(carried: Array<{ n: number; carried: boolean }>): typeof fetch {
    return (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'tool_use', name: 'record_carried', input: { carried } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
  }

  async function judged(
    carried: Array<{ n: number; carried: boolean }>,
  ): Promise<boolean[] | null> {
    const real = globalThis.fetch;
    globalThis.fetch = judgeReplying(carried);
    try {
      return await judgeCarried(cred, ideas, 'the notes');
    } finally {
      globalThis.fetch = real;
    }
  }

  it('reads a reply that answers each idea exactly once', async () => {
    expect(
      await judged([
        { n: 1, carried: true },
        { n: 2, carried: false },
        { n: 3, carried: true },
      ]),
    ).toEqual([true, false, true]);
  });

  it('refuses a reply that repeats one idea and omits another', async () => {
    // Three rows for three ideas, so a count of rows sees nothing wrong —
    // and idea 3, which the judge never reached, would have scored lost.
    expect(
      await judged([
        { n: 1, carried: true },
        { n: 2, carried: false },
        { n: 2, carried: true },
      ]),
    ).toBeNull();
  });

  it('refuses a reply that repeats an idea even when every idea is answered', async () => {
    // Four rows covering all three ideas, so the distinct-index count is
    // satisfied. A judge that answered one idea twice has lost its place in
    // the list, and which of its two answers is the real one is unknowable.
    expect(
      await judged([
        { n: 1, carried: true },
        { n: 2, carried: false },
        { n: 2, carried: true },
        { n: 3, carried: true },
      ]),
    ).toBeNull();
  });

  it('still refuses a reply that is simply short', async () => {
    expect(await judged([{ n: 1, carried: true }])).toBeNull();
  });
});
