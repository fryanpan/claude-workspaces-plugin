/**
 * Whose circle is whose in the presence deck, in a real browser at 1180x820
 * and 430x932. `presence-faces-browser-driver.ts` drives a real server, the
 * real bundles, three signed-in people and three listening agents; these
 * cases assert on its JSON.
 *
 * Bryan, on the iPad (2026-11-15): "a bunch of bubbles up top with almost
 * all the same color instead of different colors and no user or agent name
 * indicators". What a fake DOM cannot say: the fill the browser paints, and
 * whether a neighbouring circle covers the letters.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { FaceRead, FacesRound } from './presence-faces-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'presence-faces-browser-driver.ts');
const SUITE_MS = 220_000;
const SPAWN_MS = 210_000;

/** The largest per-channel gap between two `rgb(r, g, b)` fills. Two fills
 *  closer than this are, at 20px, one colour. */
const APART = 45;
function gap(a: string, b: string): number {
  const ch = (c: string) => (c.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  const [x, y] = [ch(a), ch(b)];
  return Math.max(...x.map((v, i) => Math.abs(v - (y[i] ?? 0))));
}

let rounds: FacesRound[] = [];
const round = (width: number): FacesRound => {
  const r = rounds.find((x) => x.width === width);
  if (!r) throw new Error(`no round at ${width}`);
  return r;
};

describe.skipIf(CHROME === null)('the presence deck’s faces, in a browser', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    rounds = (JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as { rounds: FacesRound[] })
      .rounds;
  }, SUITE_MS);

  for (const [width, drawn] of [
    [1180, 4],
    [430, 3],
  ] as const) {
    it(`paints each person and agent in the deck a different colour at ${width}`, () => {
      const { deck } = round(width);
      // CONTROL: the deck was read, people and agents both.
      expect(deck.length).toBe(drawn);
      expect(deck.some((f) => f.kind === 'person')).toBe(true);
      expect(deck.some((f) => f.kind === 'agent')).toBe(true);
      for (const [i, a] of deck.entries()) {
        expect(a.fill, a.key).toMatch(/^rgb\(/);
        for (const b of deck.slice(i + 1)) {
          expect(gap(a.fill, b.fill), `${a.key} ${a.fill} vs ${b.key} ${b.fill}`).toBeGreaterThan(
            APART,
          );
        }
      }
    }, 60_000);

    it(`shows every circle's initials, uncovered, at ${width}`, () => {
      for (const f of round(width).deck) {
        expect(f.letters, f.key).toMatch(/^[A-Z]{1,2}$/);
        expect(f.letterPx, f.key).toBeGreaterThanOrEqual(8);
        expect(f.onTop, `${f.key}: a neighbour covers its centre`).toBe(true);
      }
    }, 60_000);

    it(`draws an agent as a rounded square and a person as a circle at ${width}`, () => {
      const shape = (f: FaceRead) => f.radius === '50%';
      for (const f of round(width).deck) expect(shape(f), f.key).toBe(f.kind === 'person');
    }, 60_000);

    it(`gives a participant one colour in the deck, the list and on a doc at ${width}`, () => {
      const { deck, rows, docDeck } = round(width);
      for (const f of deck) expect(rows[f.key], f.key).toBe(f.fill);
      const shared = deck.filter((f) => docDeck[f.key] !== undefined);
      // CONTROL: Bob and the lead are in both decks.
      expect(shared.length).toBeGreaterThanOrEqual(2);
      for (const f of shared) expect(docDeck[f.key], f.key).toBe(f.fill);
    }, 60_000);
  }

  it('names who leads the deck beside it at 1180, and not at 430', () => {
    const wide = round(1180).names;
    expect(wide.shown).toBe(true);
    // Bob is on Alice's page, so he leads; Saltmarsh, the first of those
    // elsewhere, follows, and the lead and two agents make three more.
    expect(wide.text).toBe('Bob, Saltmarsh +3');
    expect(round(430).names.shown).toBe(false);
  }, 60_000);
});
