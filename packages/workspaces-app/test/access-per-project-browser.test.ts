/**
 * A page on one project's subdomain cannot call another project's board with
 * Bryan's session.
 *
 * `packages/server/test/access-per-project-browser-driver.ts` runs two real
 * servers, each behind a stand-in for its own Access application, on two
 * subdomains of one address that only the headless browser resolves. The
 * browser holds Bryan's Access cookie for both. The driver runs one script
 * from a Harborlight page and then from a Riverbend page: read Harborlight's
 * board, then create a board on Harborlight with a credentialed write.
 *
 * The stand-in is not Cloudflare. It admits a cookie whose audience is its
 * own application's and turns it into the stamp, which is what Access does
 * with an already signed-in visitor; what the browser sends, and what the
 * server then answers, are real.
 *
 * audit: no-text — the driver reads a running server and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { PerProjectReading } from '../../server/test/access-per-project-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, '../../server/test/access-per-project-browser-driver.ts');
/** Two servers, two stand-ins, one launch and two page loads. */
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

let reading: PerProjectReading;

describe.skipIf(CHROME === null)("another project's page and Bryan's session", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    reading = JSON.parse(last) as PerProjectReading;
  }, SUITE_MS);

  it("CONTROL: Harborlight's own page reads its board and writes as Bryan", () => {
    expect(reading.sameProject).toEqual({
      read: 'Harborlight board',
      write: '200',
      written: true,
    });
  });

  it("the browser sends Bryan's Harborlight cookie on the Riverbend page's calls", () => {
    // So the refusals below are the server's, not a cookie the browser kept back.
    expect(reading.fromOther.map((r) => r.method)).toEqual(['GET', 'POST']);
  });

  it('the Riverbend page cannot read the board', () => {
    expect(reading.otherProject.read).toBe('blocked');
  });

  it("Harborlight refuses the Riverbend page's write, and nothing is created", () => {
    expect(reading.fromOther.find((r) => r.method === 'POST')?.status).toBe(403);
    expect(reading.otherProject.written).toBe(false);
  });
});
