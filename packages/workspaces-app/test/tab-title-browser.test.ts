/**
 * Every page's browser tab title starts with the workspace's name and then
 * names the page, at 1180x820 and 430x932, and follows a rename of the
 * workspace or of the page's own thing without a reload.
 * `tab-title-browser-driver.ts` drives headless Chromium against a real
 * server and the real bundles; these cases assert on the JSON it prints.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { EXPECTED, PAGE_KINDS, type TabTitleRun } from './tab-title-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'tab-title-browser-driver.ts');
/** Two bundle builds, two launches, nineteen page loads. */
const SUITE_MS = 240_000;
const SPAWN_MS = 235_000;

let run: TabTitleRun | null = null;
const result = (): TabTitleRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('browser tab titles', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as TabTitleRun;
  }, SUITE_MS);

  it('every kind of page starts with the workspace name, then names itself', () => {
    const { reads } = result();
    for (const width of [1180, 430]) {
      const got = Object.fromEntries(
        reads.filter((r) => r.width === width).map((r) => [r.page, r.title]),
      );
      expect(Object.keys(got), String(width)).toEqual([...PAGE_KINDS]);
      expect(got, String(width)).toEqual(EXPECTED);
    }
  });

  it('an open page follows a rename of the workspace and of its own thing, unreloaded', () => {
    const { live } = result();
    expect(live.map((l) => l.page)).toEqual(['doc', 'mock', 'task']);
    for (const l of live) {
      expect(l.afterWorkspace.startsWith(`${l.workspace} · `), l.page).toBe(true);
      expect(l.afterName, l.page).toBe(`${l.workspace} · ${l.name} · Workspaces`);
      expect(l.sameDocument, l.page).toBe(true);
    }
  });
});
