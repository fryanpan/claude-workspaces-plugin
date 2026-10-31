/**
 * The board has no speaker button beside the agent button, and the doc bar
 * has no Record Audio, voice-feedback mic or Talk, at 1180x820 and at 430
 * (Bryan, 2026-10-30).
 *
 * `packages/server/test/retired-voice-controls-browser-driver.ts` builds the
 * client, opens both pages in headless Chromium against a real server and
 * reports what each one drew. Every page also has to show a control it
 * keeps, so a page that never finished mounting fails here rather than
 * reading as clean. Run against the commit before the removal, the same
 * driver reports `#board-mic` on the board and `.meeting-record` and
 * `.doc-voice-mic` on the doc, at both sizes.
 *
 * audit: no-text — the driver reads a running server and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { RetiredVoiceReading } from '../../server/test/retired-voice-controls-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(
  import.meta.dirname,
  '../../server/test/retired-voice-controls-browser-driver.ts',
);
/** A client build, one launch and four page loads. */
const SUITE_MS = 240_000;
const SPAWN_MS = 230_000;

let r: RetiredVoiceReading;

describe.skipIf(CHROME === null)('the retired voice controls', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as RetiredVoiceReading;
  }, SUITE_MS);

  for (const size of ['ipad', 'phone'] as const) {
    it(`the board at ${size} shows the agent button and no speaker button`, () => {
      expect(r.board[size].kept).toBe(true);
      expect(r.board[size].retired).toEqual([]);
      expect(r.board[size].namedLikeRetired).toEqual([]);
    });

    it(`the doc at ${size} has mounted, with no Record Audio, voice mic or Talk`, () => {
      expect(r.doc[size].kept).toBe(true);
      expect(r.doc[size].retired).toEqual([]);
      expect(r.doc[size].namedLikeRetired).toEqual([]);
    });
  }

  it('the pages threw nothing', () => {
    expect(r.errors).toEqual([]);
  });
});
