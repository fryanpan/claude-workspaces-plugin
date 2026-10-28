/**
 * A service worker planted on the keeper's origin while its port was free
 * is removed by the keeper, and stops approvals until the owner clears the
 * alarm, in a real browser. The driver is `keeper-service-worker-driver.ts`
 * beside it; the server suite's `keeper-hardening.test.ts` covers the same
 * headers without a browser.
 *
 * Only the worker that passes navigations on to the keeper is asserted. The
 * driver's `quiet` plant, which never reaches the keeper, survives; that is
 * the known limit in security.md, and the runbook's site-data step is what
 * removes it.
 *
 * audit: no-text — the driver reads a running keeper and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from './browser-tests.ts';
import type { ServiceWorkerReading } from './keeper-service-worker-driver.ts';

/** The browser these cases may launch, or null to skip them. */
const CHROME = chromeForSuite();
const DRIVER = join(import.meta.dirname, './keeper-service-worker-driver.ts');

let reading: ServiceWorkerReading;

describe.skipIf(CHROME === null)('a service worker planted before the keeper started', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER, 'passthrough'], { encoding: 'utf8', timeout: 55_000 });
    expect(r.status, r.stderr).toBe(0);
    reading = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as ServiceWorkerReading;
  }, 60_000);

  it('was registered on the origin', () => {
    expect(reading.planted).toBe('planted');
  });

  it('is gone after the first navigation, and the keeper answers every one after', () => {
    expect(reading.navigations.slice(1)).toEqual([
      { answeredBy: 'keeper', workersAfter: 0 },
      { answeredBy: 'keeper', workersAfter: 0 },
    ]);
  });

  it('never shows the planted page, and stops approvals until the owner clears the alarm', () => {
    expect(reading.navigations.map((n) => n.answeredBy)).not.toContain('worker');
    expect(reading.alarm).toContain('service worker');
    expect(reading.challengeStatus).toBe(423);
  });
});
