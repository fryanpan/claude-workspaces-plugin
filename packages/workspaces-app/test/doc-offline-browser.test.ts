/**
 * A doc page with the network cut: a reload shows the doc from this browser's
 * copy, and words typed offline reach the doc's file once the server is back.
 * `doc-offline-browser-driver.ts` does it in headless Chromium against a real
 * server and the real doc bundle; these cases assert on the JSON it prints.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { DocOfflineRun } from './doc-offline-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'doc-offline-browser-driver.ts');
/** Two bundle builds, one launch, two server boots, four page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: DocOfflineRun | null = null;
const result = (): DocOfflineRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('a doc page with the network cut', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as DocOfflineRun;
  }, SUITE_MS);

  it('a reload with the server stopped shows the doc the reader last saw', () => {
    const { online, offline, controlled } = result();
    expect(controlled).toBe(true);
    expect(online).toContain('The tide table for Harborlight.');
    expect(offline).toBe(online);
  });

  it('the offline page names the doc, shows its comment, and says it is reconnecting', () => {
    const { labelOffline, commentsOffline, chipOffline } = result();
    expect(labelOffline).toContain('field-notes.md');
    expect(commentsOffline).toBe(1);
    expect(chipOffline).toBe('Reconnecting…');
  });

  it('words typed offline survive an offline reload and reach the file once the server is back', () => {
    const { fileWhileOffline, offlineAfterEdit, fileAfterReconnect } = result();
    // The control: while the server was down the file did not have them.
    expect(fileWhileOffline).not.toContain('Riverbend ferry added offline.');
    expect(offlineAfterEdit).toContain('Riverbend ferry added offline.');
    expect(fileAfterReconnect).toContain(
      'The tide table for Harborlight. Riverbend ferry added offline.',
    );
  });
});
