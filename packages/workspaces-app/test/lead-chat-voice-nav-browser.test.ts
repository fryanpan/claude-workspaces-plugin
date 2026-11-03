/**
 * Voice chat with the lead goes on across a board link (Bryan, 3 Nov: "When I
 * click on a link in workspace while agent is active in voice mode, it
 * switched into meeting mode and turned off the agent … I expect to have the
 * chat continue in the same state as it was on the previous page").
 *
 * With voice on from the bar or the open panel, a tap on a link to one of the
 * board's docs (a full page load) or on the side nav (a route change in the
 * page) lands on a page that shows the same chat, still listening, with its
 * microphone streaming again and no tap on the new page, and nothing of a
 * meeting. At 1180x820 and 430x932.
 * `lead-chat-voice-nav-browser-driver.ts` drives a real server and the real
 * bundles; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { VoiceNavRun } from './lead-chat-voice-nav-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-voice-nav-browser-driver.ts');
/** One bundle build, two launches, ten page loads. */
const SUITE_MS = 250_000;
const SPAWN_MS = 240_000;

let run: VoiceNavRun | null = null;
const result = (): VoiceNavRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('voice chat with the lead, across a board link', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as VoiceNavRun;
  }, SUITE_MS);

  it('runs every way at both sizes, through both kinds of move', () => {
    const r = result();
    expect(r.cases.map((c) => `${c.width} ${c.how} ${c.link}`)).toEqual([
      '1180 bar doc',
      '1180 panel doc',
      '1180 panel nav',
      '430 bar doc',
      '430 panel nav',
    ]);
    // A doc link loads a new page; the side nav routes inside the board.
    for (const c of r.cases)
      expect(c.fullLoad, `${c.width} ${c.how} ${c.link}`).toBe(c.link === 'doc');
    for (const c of r.cases.filter((x) => x.link === 'doc')) expect(c.landed).toBe(r.docPath);
  });

  it('was listening before the link, from the bar or the panel', () => {
    for (const c of result().cases) {
      const at = `${c.width} ${c.how} ${c.link}`;
      expect(c.before.listening, at).toBe(true);
      expect(c.how === 'bar' ? c.before.barOut : c.before.paneOpen, at).toBe(true);
    }
  });

  it('is still listening on the new page, its microphone streaming, with no tap there', () => {
    for (const c of result().cases) {
      // The status line says why, when voice came back off.
      const at = `${c.width} ${c.how} ${c.link}: "${c.after.status}"`;
      expect(c.after.listening, at).toBe(true);
      expect(c.framesAfter, at).toBeGreaterThan(0);
    }
  });

  it('shows the same chat: the bar stays the bar, the panel stays the panel', () => {
    for (const c of result().cases) {
      const at = `${c.width} ${c.how} ${c.link}`;
      // On a phone the full-screen panel makes way for the nav's page into
      // the bar, listening still.
      const sheetMadeWay = c.width <= 1100 && c.how === 'panel' && c.link === 'nav';
      expect(c.after.paneOpen, at).toBe(c.how === 'panel' && !sheetMadeWay);
      expect(c.after.barOut, at).toBe(c.how === 'bar' || sheetMadeWay);
    }
  });

  it('never shows anything of a meeting', () => {
    for (const c of result().cases) {
      expect(c.before.meetingShown, `${c.width} ${c.how} ${c.link}`).toBe(false);
      expect(c.after.meetingShown, `${c.width} ${c.how} ${c.link}`).toBe(false);
    }
  });
});
