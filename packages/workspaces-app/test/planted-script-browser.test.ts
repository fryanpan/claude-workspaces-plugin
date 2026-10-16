/**
 * Script planted in a doc and in a comment runs nowhere on the doc page, in
 * a real browser against a real server: a `<script>` tag, an `<img onerror>`,
 * a `javascript:` link, and a mermaid diagram's `javascript:` click link and
 * `click … call` callback. Each is clicked with trusted mouse events.
 *
 * The driver's control, a script link of the page's own, must run, so an
 * empty record means the payloads were made inert and not that nothing could
 * run. The planted words must still be on screen as text, so a payload that
 * never reached the page cannot pass either. Mermaid's two render paths on
 * their own are `mermaid-strict-browser.test.ts`.
 *
 * Measured against two broken builds: with the comment renderer's escaping
 * removed, `comment-img` ran and script elements appeared; with the editor's
 * link filter removed, the doc's link kept its `javascript:` target.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { PlantedReading } from './planted-script-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

/** A widget build, a doc bundle build, one launch and one page. */
const SUITE_MS = 200_000;
const SPAWN_MS = 180_000;

let r: PlantedReading;

describe.skipIf(CHROME === null)('script planted in a doc and a comment', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [join(import.meta.dirname, 'planted-script-driver.ts')], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
    });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as PlantedReading;
  }, SUITE_MS);

  it('CONTROL: a script link of the page’s own runs when clicked', () => {
    expect(r.ran).toContain('control');
    expect(r.clicked).toBeGreaterThan(0);
  });

  it('reaches the page: the doc and the comment show the planted words as text', () => {
    for (const text of [r.docText, r.commentText]) {
      expect(text).toContain('<script>cwPlantedHit(');
      expect(text).toContain('<img src="x" onerror=');
      expect(text).toContain('Riverbend schedule');
    }
    expect(r.commentBodies).toBeGreaterThan(0);
    expect(r.diagramDrawn).toBe(true);
  });

  it('runs none of the payloads, in the doc or the comment', () => {
    expect(r.ran).toEqual(['control']);
  });

  it('renders none of them as live HTML', () => {
    expect(r.scripts).toBe(0);
    expect(r.handlers).toBe(0);
    expect(r.plantedImages).toBe(0);
    expect(r.scriptLinks).toBe(0);
  });

  it("keeps the doc's link as a link, with no script target", () => {
    expect(r.docLink.isLink).toBe(true);
    expect(r.docLink.href ?? '').not.toMatch(/^\s*javascript:/i);
  });
});
