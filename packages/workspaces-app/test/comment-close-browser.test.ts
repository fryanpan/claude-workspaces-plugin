/**
 * On a mock's page, comment mode's ways out never sit under the lead chat's
 * agent button, at 320, 430, 768 and 1180 wide, and at 430 a tap on each one
 * takes. `comment-close-browser-driver.ts` drives a real server and the real
 * bundles; these cases assert on its JSON.
 *
 * Seen by the owner on a phone: the agent button floated over the frame's
 * bottom-left corner, where the phone composer keeps its Cancel, so the
 * comment could not be closed.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { Box, WidthReading } from './comment-close-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'comment-close-browser-driver.ts');
const SUITE_MS = 220_000;
const SPAWN_MS = 210_000;
const WIDTHS = [320, 430, 768, 1180];

let readings: WidthReading[] = [];
const at = (width: number): WidthReading => {
  const r = readings.find((x) => x.width === width);
  if (!r) throw new Error(`no reading at ${width}`);
  return r;
};

const overlaps = (a: Box, b: Box): boolean =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

describe.skipIf(CHROME === null)("comment mode's ways out and the agent button", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as WidthReading[];
    expect(readings.map((x) => x.width)).toEqual(WIDTHS);
  }, SUITE_MS);

  for (const width of WIDTHS) {
    it(`no way out lies under the agent button, and each is on top, at ${width}`, () => {
      const r = at(width);
      expect(r.agent, 'CONTROL: the agent button is drawn').not.toBeNull();
      expect(r.composing.exits.cancel, 'CONTROL: the composer drew its Cancel').not.toBeNull();
      for (const state of [r.prompt, r.composing]) {
        for (const [name, box] of Object.entries(state.exits)) {
          if (!box) continue;
          expect(overlaps(box, r.agent as Box), `${name} under the agent button`).toBe(false);
          expect(state.onTop[name], `${name} takes a tap at its centre`).toBe(true);
        }
      }
      expect(r.agentComposing, 'the agent button holds still').toEqual(r.agent);
    });
  }

  it('a tap on Cancel closes the comment and a tap on Done ends the mode, at 430', () => {
    expect(at(430).exited).toEqual({ cancel: true, done: true });
  });
});
