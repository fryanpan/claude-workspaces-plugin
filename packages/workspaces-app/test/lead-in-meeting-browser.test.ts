/**
 * The board's lead speaks into a meeting with one tool call, and the line
 * plays and shows in the meeting, at 1180x820 and 430x932.
 * `lead-in-meeting-browser-driver.ts` does it in headless Chromium against a
 * real server and the lead's MCP spawned from source; these cases assert on
 * its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { LeadInMeetingSize } from './lead-in-meeting-browser-driver.ts';

/** The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-in-meeting-browser-driver.ts');
/** Two bundle builds, two launches, an MCP child. */
const SUITE_MS = 190_000;
const SPAWN_MS = 180_000;
const CASE_MS = 60_000;

let sizes: LeadInMeetingSize[] | null = null;
const result = (): LeadInMeetingSize[] => {
  if (!sizes) throw new Error('the driver printed nothing');
  return sizes;
};

describe.skipIf(CHROME === null)('the lead speaks into a meeting, in a browser', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '' },
    });
    expect(r.status, r.stderr).toBe(0);
    sizes = (JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as { sizes: LeadInMeetingSize[] })
      .sizes;
  }, SUITE_MS);

  it(
    'takes one say_in_meeting call and says it was played',
    () => {
      const all = result();
      expect(all.map((s) => s.width)).toEqual([1180, 430]);
      for (const s of all)
        expect(s.tool, String(s.width)).toMatchObject({ said: true, played: true });
    },
    CASE_MS,
  );

  it(
    'shows the line in the meeting on the recording tab and on a tab only watching',
    () => {
      for (const s of result()) {
        const line = `Who is the slipway for, at ${s.width}?`;
        const at = String(s.width);
        const rec = s.recorder.lead.find((l) => l.text.includes(line));
        const watch = s.watcher.lead.find((l) => l.text.includes(line));
        expect(rec?.text, at).toContain('Harborlight Lead');
        expect(watch?.text, at).toContain(line);
        // Readable in the open pane, not off the side of a narrow screen.
        expect(watch?.box, at).not.toBeNull();
        if (watch?.box) {
          expect(watch.box.height, at).toBeGreaterThan(10);
          expect(watch.box.left, at).toBeGreaterThanOrEqual(0);
          expect(watch.box.left + watch.box.width, at).toBeLessThanOrEqual(s.width);
        }
      }
    },
    CASE_MS,
  );

  it(
    'plays the line aloud on the recording tab only',
    () => {
      for (const s of result()) {
        const at = String(s.width);
        const line = `Who is the slipway for, at ${s.width}?`;
        expect(s.voiced, at).toContain(line);
        expect(s.recorder.lead.find((l) => l.text.includes(line))?.said, at).toBe('said');
        expect(s.recorder.plays.length, at).toBeGreaterThan(0);
        expect(
          s.recorder.plays.every((n) => n > 0),
          at,
        ).toBe(true);
        expect(s.watcher.plays, at).toEqual([]);
        expect(
          s.watcher.lead.every((l) => l.said === ''),
          at,
        ).toBe(true);
      }
    },
    CASE_MS,
  );
});
