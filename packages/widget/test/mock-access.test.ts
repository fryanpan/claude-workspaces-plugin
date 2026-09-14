/**
 * A served mock works behind a sign-in that refuses every request without its
 * cookie, as Cloudflare Access does in front of the board.
 *
 * The mock's frame has an opaque origin, so the browser sends none of the
 * board's cookies on a request the frame makes by itself.
 * `mock-access-driver.ts` puts a gate in front of a real board server that
 * redirects any request without the sign-in cookie, opens a mock through it in
 * headless Chromium as a signed-in reader, and reads back what the mock found
 * working and what the gate refused. The mock names a board stylesheet, a
 * classic and a module board script, and fetches voice feedback's script as
 * the mic's first tap does.
 *
 * audit: no-text — the driver reads a running server and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
// Types only: importing a value would run the driver in this process.
import type { AccessReading } from './mock-access-driver.ts';

const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const DRIVER = join(import.meta.dirname, 'mock-access-driver.ts');
/** A widget build, a server, a gate, one launch and one page load. */
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

let reading: AccessReading;

describe.skipIf(CHROME === null)('a served mock behind a sign-in gate', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    reading = JSON.parse(last) as AccessReading;
  }, SUITE_MS);

  it('CONTROL: refuses the image the frame loads by itself, so its own requests carry no cookie', () => {
    expect(reading.hostPassed).toBe(true);
    expect(reading.refused).toContain('image /app/harbor.png');
    expect(reading.report?.image).toBe(0);
  });

  it('refuses nothing else: the frame fetched nothing from the board by itself', () => {
    expect(reading.refused).toEqual(['image /app/harbor.png']);
  });

  it("runs the widget, the mock's board scripts and stylesheet, and loads voice feedback", () => {
    expect(reading.report).toEqual({
      widget: true,
      classic: true,
      module: true,
      color: 'rgb(1, 2, 3)',
      image: 0,
      voice: { status: 200, loaded: true },
    });
  });
});
