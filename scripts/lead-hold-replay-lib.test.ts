/**
 * The replay that scores how the lead's meeting line is held
 * (`lead-hold-replay-lib.ts`). Rendering and scoring are checked on a point
 * built here; the held-out set is replayed on the RECORDED judge verdicts,
 * so no call is made, and the no-hold arm must fail the bar there: if it
 * ever passes, the scoring is broken.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FINAL_LAG_MS,
  type FixtureSet,
  type Point,
  type ReplayJudge,
  WORD_MS,
  checkFixture,
  failsBar,
  render,
  replayPoint,
  score,
} from './lead-hold-replay-lib.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lead-hold');
const load = (name: string): FixtureSet =>
  JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as FixtureSet;
const recorded = (
  JSON.parse(readFileSync(join(DIR, 'judge-answers.json'), 'utf8')) as {
    answers: Record<string, { finished: boolean; latencyMs: number }>;
  }
).answers;
const judge: ReplayJudge = async (recent) => {
  const a = recorded[recent];
  if (!a) throw new Error(`no recorded verdict for ${recent}`);
  return a;
};

const POINT: Point = {
  id: 'x-c2-01',
  class: 2,
  talk: [
    { who: 'Harborlight', text: 'Saltmarsh is late.', gapAfterMs: 1800 },
    { who: 'Harborlight', text: 'Because the dredge broke.' },
  ],
  requestAt: { segment: 0, word: 1 },
};

describe('the lead hold replay', () => {
  it('renders a word per partial, a final after each stretch, and the right moment', () => {
    const r = render(POINT, 0);
    expect(r.requestMs).toBe(2 * WORD_MS);
    expect(r.frames.filter((f) => f.final).map((f) => [f.atMs, f.text])).toEqual([
      [3 * WORD_MS + FINAL_LAG_MS, 'Saltmarsh is late.'],
      [3 * WORD_MS + 1800 + 4 * WORD_MS + FINAL_LAG_MS, 'Because the dredge broke.'],
    ]);
    expect(r.okFromMs).toBe(3 * WORD_MS + 1800 + 4 * WORD_MS);
    // Every fourth point is heard without punctuation.
    expect(render(POINT, 3).frames.at(-1)?.text).toBe('Because the dredge broke');
  });

  it('scores the gate cutting into a whole sentence with more to come', async () => {
    const gate = await replayPoint(POINT, 0, { arm: 'gate' }, null);
    expect(gate).toMatchObject({ outcome: 'cut' });
    const s = score([gate]);
    expect([s.cuts, s.released, s.unsaid]).toEqual([1, 1, 0]);
  });

  it('holds both fixtures to their shape', () => {
    for (const set of ['dev', 'heldout']) expect(() => checkFixture(load(set))).not.toThrow();
  });

  it('fails the bar with no hold and on the recorded verdicts reproduces the judge arm', async () => {
    const set = load('heldout');
    const run = async (arm: Parameters<typeof replayPoint>[2]) => {
      const out = [];
      for (const [i, p] of set.points.entries()) out.push(await replayPoint(p, i, arm, judge));
      return score(out);
    };
    const atOnce = await run({ arm: 'at-once' });
    const gate = await run({ arm: 'gate' });
    const judged = await run({ arm: 'judge', judged: true });
    expect(failsBar(atOnce, gate).length).toBeGreaterThan(0);
    // Nothing goes unsaid, and the judge cuts in on far fewer lines than
    // the gate does on the same 120 requests.
    expect(judged.requests).toBe(120);
    expect(judged.unsaid).toBe(0);
    expect(judged.cuts * 2).toBeLessThan(gate.cuts);
  });
});
