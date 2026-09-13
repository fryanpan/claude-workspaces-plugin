/**
 * Mermaid runs no script a diagram carries, on either render path the app
 * ships, in a real browser: a `javascript:` click link, an `<img onerror>`
 * label, a `<script>` label and a `click … call` callback, all clicked with
 * trusted mouse events. Under `securityLevel: 'loose'` the click links run;
 * this is the test that goes red if either call site goes back to it.
 *
 * Every reading must also still have drawn its diagram — a path that renders
 * nothing runs nothing too, and would pass the rest.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { Reading } from './mermaid-strict-driver.ts';

const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

/** One launch, a bundle of mermaid, four renders with their clicks. */
const BROWSER_CASE_MS = 120_000;

describe.skipIf(CHROME === null)('mermaid in headless Chrome', () => {
  it(
    'runs none of a diagram’s script payloads on the editor or the preview path',
    () => {
      const r = spawnSync('bun', [join(import.meta.dirname, 'mermaid-strict-driver.ts')], {
        encoding: 'utf8',
        timeout: BROWSER_CASE_MS - 10_000,
      });
      expect(r.status, r.stderr).toBe(0);
      const readings = JSON.parse(r.stdout) as Reading[];
      expect(readings.map((x) => `${x.path}#${x.diagram}`)).toEqual([
        'code-block#0',
        'code-block#1',
        'preview#0',
        'preview#1',
      ]);
      for (const reading of readings) {
        const at = `${reading.path} diagram ${reading.diagram}`;
        expect(reading.rendered, `${at}: ${reading.error}`).toBe(true);
        expect(reading.clicked, at).toBeGreaterThan(0);
        // The control link ran, so a click on a script URL does run here.
        expect(reading.ran, at).toEqual(['control']);
        expect(reading.scriptLinks, at).toBe(0);
        expect(reading.handlers, at).toBe(0);
        expect(reading.scripts, at).toBe(0);
      }
    },
    BROWSER_CASE_MS,
  );
});
