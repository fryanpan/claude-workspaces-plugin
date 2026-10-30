/**
 * A mock's comment view counts and lists only open threads, in a real
 * browser against a real server: a resolved thread whose element a later
 * round took away was counted open and listed under New, which is how a mock
 * with no open thread came to say "36 open on 1 page". A resolve and a
 * reopen made elsewhere reach the open page without a reload.
 *
 * `mock-open-count-driver.ts` drives the page; this file asserts on what it
 * measured.
 *
 * audit: no-text — the driver measures a running browser and server.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { Reading } from './mock-open-count-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'mock-open-count-driver.ts');
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let r: Reading | null = null;
const reading = (): Reading => {
  if (!r) throw new Error('the driver printed no reading');
  return r;
};

describe.skipIf(CHROME === null)('the open count on a served mock', () => {
  beforeAll(() => {
    const out = spawnSync('bun', [DRIVER], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
      env: process.env,
    });
    expect(out.status, out.stderr).toBe(0);
    r = JSON.parse(out.stdout.trim().split('\n').pop() ?? '') as Reading;
  }, SUITE_MS);

  it('counts and lists only the open thread, leaving out resolved ones with no spot', () => {
    const { ids, loaded } = reading();
    expect(loaded.sub).toBe('1 open on 1 page');
    expect(loaded.chips).toEqual(['1 open']);
    expect(loaded.fresh).toEqual([ids.open]);
    expect(loaded.listed).toEqual([ids.open]);
  });

  it('follows a resolve and a reopen made elsewhere, without a reload', () => {
    const { ids, afterResolve, afterReopen } = reading();
    expect(afterResolve.sub).toBe('');
    expect(afterResolve.listed).toEqual([]);
    expect(afterResolve.reloaded).toBe(false);
    expect(afterReopen.sub).toBe('1 open on 1 page');
    expect(afterReopen.fresh).toEqual([ids.resolvedHere]);
    expect(afterReopen.reloaded).toBe(false);
  });
});
