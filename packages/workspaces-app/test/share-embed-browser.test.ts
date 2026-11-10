/**
 * A share-link member opening a doc with `::name{block="…"}` lines on the
 * share hostname sees the board's embed frames, as the owner does: one at an
 * allowlisted https origin, and one at an app attached to the board, whose
 * own page (text written by its own script) must render inside the frame.
 *
 * Reported on a shared board: the member saw the directive as plain text,
 * because the board's embed mapping was on no member route and the doc's
 * frame plugin draws nothing without it. Real browser, real server, real doc
 * bundle, and a genuine Access token on every request.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { ShareEmbedReading } from './share-embed-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

/** A doc bundle build, one launch and one page. */
const SUITE_MS = 200_000;
const SPAWN_MS = 180_000;
const CASE_MS = 60_000;

let r: ShareEmbedReading;

describe.skipIf(CHROME === null)("a share-link member sees the board's embed frame", () => {
  beforeAll(() => {
    const run = spawnSync('bun', [join(import.meta.dirname, 'share-embed-browser-driver.ts')], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
    });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as ShareEmbedReading;
  }, SUITE_MS);

  const APP_SRC = /^\/workspaces\/[^/]+\/apps\/[^/]+\/embed\/tide-chart\/\?/;

  it(
    "the owner's page draws both frames and renders the app (the control)",
    () => {
      expect(r.owner.embedsStatus).toBe(200);
      expect(r.owner.originFrame?.src).toBe('https://harborlight.example/embed/ferry-map/');
      expect(r.owner.appFrame?.src).toMatch(APP_SRC);
      expect(r.owner.appRendered).toBe(true);
    },
    CASE_MS,
  );

  it(
    "reads the board's embed mapping from the share hostname",
    () => {
      expect(r.member.embedsStatus).toBe(200);
    },
    CASE_MS,
  );

  it(
    'draws the frame at the allowlisted origin for the directive',
    () => {
      expect(r.member.originFrame).toEqual({
        src: 'https://harborlight.example/embed/ferry-map/',
        origin: 'https://harborlight.example',
        block: 'ferry-map',
      });
    },
    CASE_MS,
  );

  it(
    "draws the app-mount frame and the app's own scripted page renders in it",
    () => {
      expect(r.member.appFrame?.src).toMatch(APP_SRC);
      expect(r.member.appFrame?.block).toBe('tide-chart');
      expect(r.member.appRendered).toBe(true);
    },
    CASE_MS,
  );
});
