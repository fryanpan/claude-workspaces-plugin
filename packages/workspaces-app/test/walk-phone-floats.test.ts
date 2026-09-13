/**
 * On a phone, Home's walkthrough keeps its buttons out from under the feedback
 * widget, and a hand-over does not leave its confirmation over the next ask.
 *
 * THE WIDGET. Its buttons are a `position: fixed` column 66px in from the
 * viewport's right edge. At ≤720 a walk form's last button stretched to the
 * card's edge, 29px in, so wherever the scroll put it beside that column its
 * right end belonged to the widget: at 390x844 and 430x844 the credential
 * form's Save first drew with a 34x43px corner that hit-tested to
 * `claude-feedback-widget` (UX review, 2026-09-12). A scroll reserve cannot
 * move a fixed box, so the buttons keep a gutter instead.
 *
 * THE TOAST. Saving a hand-over on Home showed "Saved: …" for 3.5 seconds
 * while the walk had already advanced — so at 430 the toast stood over the
 * NEXT ask's empty form, saying the same thing the "✓ Answered" banner above
 * it said (UX review, 2026-09-12). The banner is the confirmation now, and
 * it names the ask it confirms.
 *
 * WHY A REAL BROWSER. Both are "what is painted at this point", and
 * happy-dom lays nothing out.
 *
 * THE CONTROLS RUN IN THE SAME PAGE.
 *  - `saveUnguarded` / `sendUnguarded` are the same sweeps with the gutter
 *    taken off the button inline: the widget has to answer some of their
 *    points, or the clean sweeps are reading a page that could not fail.
 *  - `aligned` says each sweep really put the button beside every widget
 *    button above the dock.
 *  - `panelToast` is the task panel's hand-over through the same controller,
 *    which does toast — so the hand-over reading can see a toast when one is
 *    there.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { Reading, Sweep } from './walk-phone-floats-driver.ts';

const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const DRIVER = join(import.meta.dirname, 'walk-phone-floats-driver.ts');

/** One launch, two page loads, four sweeps and a hand-over in each. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

const SIZES = ['390x844', '430x844'] as const;

let readings: Reading[] = [];

const each = (fn: (r: Reading, size: string) => void): void => {
  for (const r of readings) fn(r, `${r.width}x${r.height}`);
};

/** A sweep that read the button beside every widget button it could. */
const expectFullSweep = (s: Sweep, label: string): void => {
  expect(s.besides.length, `${label}: widget buttons above the dock`).toBeGreaterThan(0);
  expect(s.aligned, `${label}: lined up beside each of them`).toBe(s.besides.length);
  expect(s.points, `${label}: points read`).toBeGreaterThan(0);
};

describe.skipIf(CHROME === null)("Home's walkthrough at phone width", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    expect(readings.map((x) => `${x.width}x${x.height}`)).toEqual([...SIZES]);
  }, SUITE_MS);

  it('CONTROL: without the gutter, the widget answers taps on both buttons', () => {
    each((r, size) => {
      for (const [label, s] of [
        ['Save', r.saveUnguarded],
        ['Send', r.sendUnguarded],
      ] as const) {
        expectFullSweep(s, `${size} ${label}`);
        expect(s.hitBy, `${size} ${label}: what took the taps`).toContain('claude-feedback-widget');
      }
    });
  });

  it("every point of the credential form's Save answers for itself", () => {
    each((r, size) => {
      expectFullSweep(r.save, `${size} Save`);
      expect(r.save.hitBy, `${size}: what else answered`).toEqual([]);
      expect(r.save.covered, `${size}: points not on Save`).toBe(0);
      const leftmost = Math.min(...r.widget.map((w) => w.left));
      expect(r.save.button.right, `${size}: Save ends clear of the widget`).toBeLessThan(leftmost);
    });
  });

  it("every point of a reply form's Send answers for itself", () => {
    each((r, size) => {
      expectFullSweep(r.send, `${size} Send`);
      expect(r.send.hitBy, `${size}: what else answered`).toEqual([]);
      expect(r.send.covered, `${size}: points not on Send`).toBe(0);
    });
  });

  it('CONTROL: the task panel hand-over still confirms with a toast', () => {
    each((r, size) => {
      expect(r.panelToast, `${size}: the panel toast`).toBe('Saved: saltmarsh-relay-account');
    });
  });

  it('when the next ask is on screen, the confirmation is the banner on the answered one', () => {
    each((r, size) => {
      const h = r.handOver;
      expect(h.nextFormDrawn, `${size}: the next ask's form was drawn`).toBe(true);
      expect(h.toast, `${size}: no toast over it`).toBeNull();
      expect(h.toastsSeen, `${size}: no toast on the way there either`).toEqual([]);
      expect(h.banner, `${size}: the banner names the ask it confirms`).toBe(
        '✓ Answered “Post the nightly index to the Saltmarsh relay”',
      );
    });
  });
});
