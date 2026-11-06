/**
 * A page on another port of the board's tailnet host signs in through the
 * widget and posts a comment, in a real browser.
 *
 * `widget-tailnet-sign-in-driver.ts` runs the deployment's shape over TLS: the
 * dev page on `https://<tailnet host>:10000`, the board behind `tailscale
 * serve` on the same name, and the sign-in popup on the operator's Access
 * host. It runs twice, because the two kinds of page take different paths
 * through the door: a page the widget's own first socket made a doc for, and
 * a dev server attached to the board with `attach_app`.
 *
 * audit: no-text — the driver reads a running server and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { TailnetSignInReading } from '../../server/test/widget-tailnet-sign-in-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, '../../server/test/widget-tailnet-sign-in-driver.ts');
/** A widget build, a server, one launch, a page load and a popup. */
const CASE_MS = 120_000;
const SPAWN_MS = 110_000;

function drive(kind: 'new' | 'app'): TailnetSignInReading {
  const r = spawnSync('bun', [DRIVER, kind], { encoding: 'utf8', timeout: SPAWN_MS });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as TailnetSignInReading;
}

describe.skipIf(CHROME === null)('the widget on another port of the tailnet host', () => {
  it.each(['new', 'app'] as const)(
    'signs in on the Access host and posts as the person: %s doc',
    (kind) => {
      const reading = drive(kind);
      const evidence = JSON.stringify(reading.requests);
      expect(reading.pageOrigin).toBe('https://riverbend-host.tailnet-name.test:10000');
      expect(reading.offered).toBe(true);
      expect(reading.popupOrigin).toBe('https://operator.example.com');
      expect(reading.tokenOrigin, evidence).toBe(reading.pageOrigin);
      expect(reading.tokenBoard).toBe(reading.board);
      expect(reading.comment, evidence).toEqual({
        text: 'the third chart has no axis labels',
        authorId: reading.signedInAs,
      });
    },
    CASE_MS,
  );
});
