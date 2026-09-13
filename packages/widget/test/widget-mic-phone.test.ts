/**
 * The mic, and the hover labels, on a phone-sized screen.
 *
 * Two defects the fresh-eyes pass on the feedback-buttons change turned up,
 * both invisible to happy-dom because both are layout:
 *
 * 1. At 430 wide, entering comment mode took the mic off the screen. The phone
 *    face folds the floating buttons away under its bottom panel, and the mic
 *    wears `.fab-list` for its look and its slot, so it folded with the thread
 *    list — leaving the width where speaking beats typing with no way to speak.
 * 2. The hover labels ran off the LEFT edge. They are pushed left of a button
 *    that already sits near the right edge, and the host's words say whose
 *    feedback the button takes, which is a long sentence: measured against the
 *    base commit with the same probe, the three labels' left edges were -63,
 *    -42 and -112.
 *
 * `mic-phone-driver.ts` loads the widget plus its mic entry into headless
 * Chromium at 1180x820 and 430x932 and measures what was painted. 1180 is the
 * control throughout: nothing about it should have moved.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { Box, Look, Reading, Tip } from './mic-phone-driver.ts';

const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const DRIVER = join(import.meta.dirname, 'mic-phone-driver.ts');
/** One launch, two page loads, a handful of real inputs and six hovers. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

/** The floor a finger needs. The widget's own chrome is built to 44. */
const TAP_FLOOR = 36;

let readings: Reading[] = [];
const at = (width: number): Reading => {
  const r = readings.find((x) => x.width === width);
  if (!r) throw new Error(`no reading at ${width}`);
  return r;
};
const look = (width: number, name: string): Look => {
  const l = at(width).looks[name];
  if (!l) throw new Error(`no look "${name}" at ${width}`);
  return l;
};
const tip = (width: number, where: 'tips' | 'tipsInMode', name: string): Tip => {
  const t = at(width)[where][name];
  if (!t) throw new Error(`no ${where} reading for ${name} at ${width}`);
  return t;
};
const painted = (b: Box | null | undefined, what: string): Box => {
  if (!b) throw new Error(`expected ${what} to be painted`);
  return b;
};
/** Square pixels two boxes share. */
function overlap(a: Box | null, b: Box | null): number {
  if (!a || !b) return 0;
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

describe.skipIf(CHROME === null)('the mic and its labels at phone width', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    // The control for everything below: both page loads ran, the mic mounted
    // at each, and the mode armed — a widget that entered no mode would pass
    // every "still there in the mode" case by never leaving the idle state.
    expect(readings.map((x) => x.width)).toEqual([1180, 430]);
    for (const width of [1180, 430]) {
      expect(look(width, 'idle').mic, `a mic at ${width}`).not.toBeNull();
      expect(look(width, 'entered').mode, `the mode armed at ${width}`).toBe(true);
      expect(look(width, 'composing').composer, `a composer at ${width}`).not.toBeNull();
      expect(look(width, 'refused').note, `a refusal at ${width}`).toContain('Sign in');
    }
  }, SUITE_MS);

  describe('comment mode keeps the mic', () => {
    it('leaves it on screen at 430, where the rest of the chrome folds away', () => {
      // The fold is real and still wanted — this is the narrow exemption, not
      // its removal, so the two controls are the buttons that DO fold.
      for (const name of ['entered', 'composing']) {
        const l = look(430, name);
        expect(l.fab, `CONTROL: the FAB folds under the panel (${name})`).toBeNull();
        expect(l.list, `CONTROL: so does the thread list (${name})`).toBeNull();
        const mic = painted(l.mic, `the mic in the mode (${name})`);
        expect(mic[2] - mic[0], `mic width (${name})`).toBeGreaterThanOrEqual(TAP_FLOOR);
        expect(mic[3] - mic[1], `mic height (${name})`).toBeGreaterThanOrEqual(TAP_FLOOR);
      }
    });

    it('stands clear of the panel it would otherwise be under', () => {
      // Reachable is not the same as painted: a mic behind the composer panel
      // is on the screen and under a reviewer's thumb at once.
      // Through `painted`, because zero overlap is also what a mic that was
      // never drawn reports — the case above is about it being there, and this
      // one must not pass by agreeing that it is not.
      const l = look(430, 'composing');
      expect(overlap(painted(l.mic, 'the mic'), l.composer), 'the panel covers the mic').toBe(0);
      const e = look(430, 'entered');
      expect(overlap(painted(e.mic, 'the mic'), e.panel), 'the prompt covers the mic').toBe(0);
    });

    it('rises above the panel when a refusal makes it taller', () => {
      // Painted is not reachable. The panel grows with its contents — the
      // composer's row, plus a line of news and a Sign in button when the
      // workspace wants a signature — and a mic in a fixed slot 74px up
      // cleared the short form by ten pixels and vanished under the tall one.
      const l = look(430, 'refused');
      const composer = painted(l.composer, 'the refused composer');
      const short = painted(look(430, 'composing').composer, 'the plain composer');
      expect(
        composer[3] - composer[1],
        'CONTROL: the refusal really did make the panel taller',
      ).toBeGreaterThan(short[3] - short[1]);
      expect(l.note, 'CONTROL: and it is the sign-in row that did it').toContain('Sign in to post');
      const mic = painted(l.mic, 'the mic over a tall panel');
      expect(overlap(mic, composer), 'the panel covers the mic').toBe(0);
      expect(mic[3], 'the mic sits above the panel').toBeLessThanOrEqual(composer[1]);
    });

    it('CONTROL: at 1180 nothing moved — the mic stands where it always did', () => {
      // The panel is a phone-face thing; a tablet card never pushes anything.
      const idle = painted(look(1180, 'idle').mic, 'the mic at 1180');
      expect(look(1180, 'entered').mic).toEqual(idle);
      expect(look(1180, 'composing').mic).toEqual(idle);
      expect(look(1180, 'refused').mic).toEqual(idle);
    });

    it('gives the mic back its neighbours when the mode ends', () => {
      for (const width of [1180, 430]) {
        expect(look(width, 'done').list, `the list is back at ${width}`).not.toBeNull();
        expect(look(width, 'done').mic, `and so is the mic at ${width}`).not.toBeNull();
      }
    });
  });

  describe('the hover labels stay on the screen', () => {
    it('keeps every label inside the left edge at 430', () => {
      for (const where of ['tips', 'tipsInMode'] as const) {
        for (const name of ['voice', 'comment', 'history']) {
          const t = tip(430, where, name);
          // A button that folded in the mode has no label to place; the cases
          // above are what say which buttons are supposed to be there.
          if (!t.box) continue;
          expect(t.text, `${where} ${name} says something`).toBeTruthy();
          expect(t.box[0], `${where} ${name} left edge`).toBeGreaterThanOrEqual(0);
          expect(t.box[2], `${where} ${name} right edge`).toBeLessThanOrEqual(430);
        }
      }
    });

    it('CONTROL: the labels being measured are the long ones that ran off', () => {
      // A label short enough to fit anyway would pass the case above on a
      // stylesheet with no cap in it at all.
      for (const name of ['voice', 'comment', 'history']) {
        expect(String(tip(430, 'tips', name).text).length, `${name} label`).toBeGreaterThan(60);
      }
    });

    it('draws no mic label over a note beside the mic', () => {
      for (const width of [1180, 430]) {
        expect(at(width).micLabelNoNote, `CONTROL: the label shows with no note (${width})`).toBe(
          true,
        );
        expect(at(width).micLabelUnderNote, `no label over the note (${width})`).toBe(false);
      }
    });

    it('CONTROL: does not narrow a label at 1180, where there is room', () => {
      // The cap is the screen, not a house width — a tablet label still says
      // its sentence on one line, which is what it did before the fix.
      const capAt430 = 430 - 88;
      for (const name of ['voice', 'comment', 'history']) {
        const t = tip(1180, 'tips', name);
        const b = painted(t.box, `the ${name} label at 1180`);
        expect(b[0], `${name} left edge at 1180`).toBeGreaterThanOrEqual(0);
        expect(b[2] - b[0], `${name} is not squeezed at 1180`).toBeGreaterThan(capAt430);
      }
    });
  });
});
