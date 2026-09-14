/**
 * A mock's own script cannot write to another doc as the reader.
 *
 * Measured on staging before the sandbox existed: a mock planted threads on a
 * different doc, each attributed to the signed-in reader. `mock-sandbox-driver.ts`
 * serves a hostile mock from a real server into headless Chromium and tries
 * eight kinds of write on a second doc from inside the mock's frame, then the
 * same eight from the page holding the frame; this file asserts on what the
 * server stored. The frame's report also carries the reader's name as the
 * frame read it, which the host hands over when it makes the frame.
 *
 * audit: no-text — the driver reads a running server; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
// Types only: importing a value would run the driver in this process.
import type { Reading } from './mock-sandbox-driver.ts';

const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const DRIVER = join(import.meta.dirname, 'mock-sandbox-driver.ts');
/** Two builds, a server, one launch and two runs of the attack. */
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

const KINDS = [
  'fetch',
  'xhr-json',
  'xhr-text',
  'beacon',
  'form',
  'socket',
  'worker-fetch',
  'worker-socket',
];

let reading: Reading;

describe.skipIf(CHROME === null)("a served mock's script, writing to another doc", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    reading = JSON.parse(last) as Reading;
  }, SUITE_MS);

  it('CONTROL: each of the eight lands from a page that is not sandboxed', () => {
    const landed = KINDS.filter((k) => reading.victim.includes(`control:${k}`));
    expect(landed, JSON.stringify(reading.control)).toEqual(KINDS);
  });

  it('lands none of the eight from inside the mock', () => {
    const planted = reading.victim.filter((t) => t.startsWith('frame:'));
    expect(planted, JSON.stringify(reading.frame)).toEqual([]);
    // Every attempt ran to an answer, so none is absent for want of being tried.
    expect(Object.keys(reading.frame).sort()).toEqual([...KINDS].sort());
  });

  it("still writes to the mock's own doc through the page holding it, stamped", () => {
    expect(reading.report.via).toBe('mock-frame');
  });

  it("hands the frame the reader's stored name, so a known reader is not asked again", () => {
    expect(reading.report.name).toBe('Sample Reader');
  });
});
