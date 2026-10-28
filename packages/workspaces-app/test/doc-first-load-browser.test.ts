/**
 * A doc's first load on a phone over 5G shows its text having transferred
 * under 250 KB, and paints it before the editor's chunk is even requested.
 *
 * `doc-first-load-browser-driver.ts` does it in headless Chromium against a
 * real server and the real doc bundle, cold, through a relay that paces the
 * bytes at ~9 Mbps with a 150 ms round trip, with the CPU slowed four times;
 * these cases assert on the JSON it prints.
 *
 * No case asserts a duration. "Readable at once" is held by two things a
 * loaded runner cannot move: the bytes before the text, and the order of the
 * text, the editor's request and the editor. The two controls make the
 * throttled load a real one. The relay's own rate is measured on a known
 * uncompressed payload, because Chrome's network emulation was measured lying
 * by a factor of thirty, and the unthrottled load has to be the faster one, or
 * the throttle was never applied.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { DocFirstLoadRun } from './doc-first-load-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'doc-first-load-browser-driver.ts');
/** A bundle build, two browser launches, one server. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: DocFirstLoadRun | null = null;
const result = (): DocFirstLoadRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)("a doc's first load on a phone over 5G", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as DocFirstLoadRun;
  }, SUITE_MS);

  it('control: the relay delivers the rate it was set to', () => {
    const { relayBitsPerSecond, configuredBitsPerSecond } = result();
    expect(relayBitsPerSecond).toBeGreaterThan(configuredBitsPerSecond * 0.85);
    expect(relayBitsPerSecond).toBeLessThan(configuredBitsPerSecond * 1.1);
  });

  it('control: the same load unthrottled shows the text sooner', () => {
    const { throttled, unthrottled } = result();
    expect(unthrottled.textMs).toBeLessThan(throttled.textMs);
  });

  it('transfers under 250 KB before the text is on screen', () => {
    // 769,040 bytes before this change, when the editor, CodeMirror and the
    // stylesheets' comments all came first; 113,796 after.
    expect(result().throttled.bytesBeforeText).toBeLessThan(250_000);
  });

  it('paints the text before the editor mounts, and before it asks for the editor', () => {
    // An order, not a duration: a time bar here failed CI at 2,133 ms on a
    // branch that touched neither the page nor this test, and the 250 KB case
    // already tells this bundle from the one before it.
    const { throttled, unthrottled } = result();
    for (const load of [throttled, unthrottled]) {
      expect(load.editorMs).toBeGreaterThanOrEqual(load.textMs);
      // The control: the editor's chunk was requested at all, so the order
      // below is read off a real request.
      expect(load.editorChunkRequestedMs).not.toBeNull();
      expect(load.editorChunkRequestedMs ?? -1).toBeGreaterThanOrEqual(load.textMs);
    }
  });
});
