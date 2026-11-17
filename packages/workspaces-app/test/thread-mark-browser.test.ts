/**
 * An agent marks a comment on an already-open doc working, then done, and
 * each mark reaches the card within 1s, with no reload, at 1180x820 and at
 * 430x932. The card keeps its size and place; at 430 the reader asked for
 * reduced motion and the marks hold still. `thread-mark-browser-driver.ts`
 * drives the pages against a real server; these cases assert on its JSON.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { MarkRead, ThreadMarkRun } from './thread-mark-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'thread-mark-browser-driver.ts');
/** Two bundle builds, two launches, two page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: ThreadMarkRun = { pages: {} };

/** Awaited rather than `spawnSync`: a worker blocked on a browser launch stops
 *  answering vitest's RPC. */
function drive(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [DRIVER], { timeout: SPAWN_MS });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const page = (width: string) => {
  const p = run.pages[width];
  if (!p) throw new Error(`no reading at ${width}`);
  return p;
};
const box = (r: MarkRead | null | undefined) => ({ card: r?.card, glyph: r?.glyph });

describe.skipIf(CHROME === null)('an agent mark on an open doc comment', () => {
  beforeAll(async () => {
    const r = await drive();
    expect(r.code, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as ThreadMarkRun;
  }, SUITE_MS);

  for (const width of ['1180', '430']) {
    it(`${width}: an unmarked card wears no mark`, () => {
      const before = page(width).before;
      expect(before, 'the card is on the page').not.toBeNull();
      expect(before?.mark).toBeNull();
      expect(before?.dots).toBe(0);
      expect(before?.check).toBe(false);
    }, 60_000);

    it(`${width}: working shows within 1s as three breathing dots`, () => {
      const s = page(width).working;
      expect(s?.inTime).toBe(true);
      expect(s?.read?.mark).toBe('working');
      expect(s?.read?.dots).toBe(3);
    }, 60_000);

    it(`${width}: done shows within 1s as the check`, () => {
      const s = page(width).done;
      expect(s?.inTime).toBe(true);
      expect(s?.read?.mark).toBe('done');
      expect(s?.read?.check).toBe(true);
      expect(s?.read?.dots).toBe(0);
    }, 60_000);

    it(`${width}: the card and its glyph keep their size and place`, () => {
      const p = page(width);
      expect(box(p.working?.read)).toEqual(box(p.before));
      expect(box(p.done?.read)).toEqual(box(p.before));
    }, 60_000);
  }

  it('1180: the dots breathe and the check draws', () => {
    expect(page('1180').working?.read?.dotAnimation).toEqual([
      'cw-breathe',
      'cw-breathe',
      'cw-breathe',
    ]);
    expect(page('1180').done?.read?.checkAnimation).toBe('cw-draw');
  }, 60_000);

  it('430, reduced motion: the dots hold still and the check appears drawn', () => {
    expect(page('430').working?.read?.dotAnimation).toEqual(['none', 'none', 'none']);
    expect(page('430').working?.read?.dotOpacity).toEqual([0.85, 0.85, 0.85]);
    expect(page('430').done?.read?.checkAnimation).toBe('none');
  }, 60_000);
});
