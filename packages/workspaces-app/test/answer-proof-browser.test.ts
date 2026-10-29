/**
 * The owner's tap on a review item from the board page records as his, on an
 * iPad and on a Mac, in a real browser against a real server.
 *
 * Since `packages/server/src/review-items/answer-proof.ts` a person's answer
 * is recorded only from that person's own proven, same-origin request; a body
 * naming the owner is refused. `packages/server/test/answer-proof-browser-driver.ts`
 * opens the board in headless Chromium twice — as an iPad on the Access
 * hostname (1180x820, touch), and as a Mac on loopback holding the session
 * cookie — taps "Ship today" on a decision an agent filed, and reads back who
 * the server recorded. The control is an agent's loopback claim of the owner
 * on a third item, refused in the same run.
 *
 * audit: no-text — the driver reads a running server and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { AnswerProofReading } from '../../server/test/answer-proof-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, '../../server/test/answer-proof-browser-driver.ts');
/** A client build, one launch and two page loads. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let r: AnswerProofReading;

describe.skipIf(CHROME === null)("the owner's answer from the board page", () => {
  beforeAll(() => {
    const run = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as AnswerProofReading;
  }, SUITE_MS);

  it('CONTROL: an agent claiming the owner over loopback is refused in the same run', () => {
    expect(r.loopbackClaimStatus).toBe(403);
    expect(r.loopbackClaimRecorded).toBe(false);
  });

  it("records the iPad's tap as the owner's", () => {
    expect(r.ipad).toEqual({ text: 'Ship today', answeredById: r.ownerId });
  });

  it("records the Mac's tap as the owner's", () => {
    expect(r.mac).toEqual({ text: 'Ship today', answeredById: r.ownerId });
  });

  it('the page threw nothing', () => {
    expect(r.errors).toEqual([]);
  });
});
