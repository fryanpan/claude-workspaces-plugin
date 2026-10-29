/**
 * The lead chat's meeting in a browser, at 1180x820 and 430x932: started from
 * the wizard, live on a second tab, resumed on every page the recording tab
 * moves to, the board's pages beside a mock, and ended from the other tab.
 * `lead-chat-meeting-browser-driver.ts` does it in headless Chromium against
 * a real server; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { MeetingBrowserRun } from './lead-chat-browser-reading.ts';

/** The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-meeting-browser-driver.ts');
/** Two bundle builds, two launches, fourteen page loads. */
const SUITE_MS = 260_000;
const SPAWN_MS = 250_000;

let run: MeetingBrowserRun | null = null;
const result = (): MeetingBrowserRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('the lead chat meeting in a browser', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as MeetingBrowserRun;
    // The measured gaps, for the PR and anybody reading the CI log.
    for (const s of run.sizes) {
      process.stderr.write(
        `[meeting @${s.width}] line on the watching tab after ${s.watcherMs}ms; gaps ${s.moves.map((m) => `${m.surface} ${m.gapMs}ms${m.tapped ? ' (tap)' : ''}`).join(', ')}\n`,
      );
    }
  }, SUITE_MS);

  it('starts from the wizard into a one-row heading with End meeting, at both sizes', () => {
    const { sizes } = result();
    expect(sizes.map((s) => s.width)).toEqual([1180, 430]);
    for (const s of sizes) {
      const at = String(s.width);
      expect(s.headText, at).toMatch(/^Meeting.*End meeting$/);
      expect(s.head?.height, at).toBeLessThanOrEqual(44);
      expect(s.wizard, at).not.toBeNull();
      if (!s.wizard) continue;
      expect(s.wizard.top + s.wizard.height, at).toBeLessThanOrEqual(s.viewport.height);
      if (s.width === 430) expect(s.wizard.width, at).toBe(s.viewport.width);
      else expect(s.wizard.width, at).toBe(440);
    }
  });

  it('shows a line said in the meeting on a second tab that is only watching', () => {
    for (const s of result().sizes) {
      // The driver waits for the line on each tab and fails if it never
      // comes; how long it took is reported, not asserted (testing standard 3).
      expect(typeof s.watcherMs, String(s.width)).toBe('number');
      expect(typeof s.recorderMs, String(s.width)).toBe('number');
    }
  });

  it('resumes the same recording on every page the recording tab moves to, with the notes kept', () => {
    for (const s of result().sizes) {
      expect(s.moves.map((m) => m.surface)).toEqual(['tasks', 'home', 'library', 'mock', 'doc']);
      for (const m of s.moves) {
        const at = `${m.surface}@${s.width}`;
        expect(m.headShown, at).toBe(true);
        expect(m.notesKept, at).toBe(true);
        expect(m.paneOpen, at).toBe(true);
        // Chrome starts the microphone on a page it has already granted, so
        // no move needed a tap here; iPad Safari does need one (PR body).
        expect(m.tapped, at).toBe(false);
      }
    }
  });

  it('draws the board’s four pages beside a mock: a rail when wide, a bar along the foot on a phone', () => {
    for (const s of result().sizes) {
      const mock = s.moves.find((m) => m.surface === 'mock');
      const at = String(s.width);
      expect(mock?.navLinks, at).toEqual(['Home', 'Tasks', 'Library', 'Activity']);
      const nav = mock?.nav;
      const frame = mock?.frame;
      expect(nav && frame, at).toBeTruthy();
      if (!nav || !frame) continue;
      if (s.width === 1180) {
        expect(nav.left, at).toBe(0);
        expect(frame.left, at).toBe(nav.width);
      } else {
        expect(nav.top + nav.height, at).toBe(s.viewport.height);
        expect(frame.top + frame.height, at).toBe(nav.top);
      }
      expect(mock?.buttonOnTop, at).toBe(true);
    }
  });

  it('End meeting on the other tab stops the recording and ends it for the board', () => {
    for (const s of result().sizes) {
      expect(s.framesAfterEnd, String(s.width)).toBe(0);
      expect(s.endedOnServer, String(s.width)).toBe(true);
    }
  });
});
