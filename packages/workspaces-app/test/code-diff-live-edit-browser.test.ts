/**
 * A code file's Diff view stays a diff while the agent saves the file under a
 * LIVE working-tree review. `code-diff-live-edit-browser-driver.ts` opens the
 * review in headless Chromium against a real server and the real doc bundle,
 * rewrites the file on disk, and prints what the page showed before and
 * after; these cases assert on that JSON.
 *
 * Positive control: with origin/main's `file-binding.ts`, `code-editor.ts`
 * and `diff-extensions.ts` restored, the save left the Diff button active but
 * drew zero "unchanged lines" bars and all 126 lines of the file. The server
 * replaced the whole `content` text on every disk change, so CodeMirror's
 * merge view lost every collapsed stretch and the diff read as the whole
 * file.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { LiveEditRun } from './code-diff-live-edit-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'code-diff-live-edit-browser-driver.ts');
/** One bundle build, one launch, one page load. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: LiveEditRun | null = null;
const result = (): LiveEditRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('a live code diff while the file changes on disk', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as LiveEditRun;
  }, SUITE_MS);

  it('opens in Diff with its unchanged stretches collapsed', () => {
    const { before } = result();
    expect(before.fileMode).toBe(false);
    expect(before.diffButtonActive).toBe(true);
    expect(before.collapsedBars).toBeGreaterThan(0);
  });

  it('shows the new change as a diff', () => {
    const { after } = result();
    expect(after.lines).toContain("const port = 'harborlight';");
    expect(after.deleted).toContain("const port = 'riverbend';");
  });

  it('stays in Diff, with the stretches the save did not touch still collapsed', () => {
    const { before, after } = result();
    expect(after.fileMode).toBe(false);
    expect(after.diffButtonActive).toBe(true);
    expect(after.collapsedBars).toBeGreaterThanOrEqual(before.collapsedBars);
    expect(after.lines).not.toContain('const buoy60 = 60;');
    expect(after.lines).not.toContain('const buoy10 = 10;');
  });

  it('keeps the comment pill the reader had open', () => {
    expect(result().before.pillShown).toBe(true);
    expect(result().after.pillShown).toBe(true);
  });
});
