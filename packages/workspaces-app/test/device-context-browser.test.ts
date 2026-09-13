/**
 * The location consent in a real browser, with Chrome's own permission set
 * over CDP: granted, denied, and left at `prompt` — which headless Chrome
 * answers the way a person dismissing the prompt does, `PERMISSION_DENIED`
 * with the permission still reading `prompt`. That last one is the case the
 * stored answer exists for, and no fake can vouch for how a browser reports it.
 *
 * Each scenario loads the page twice in one profile; the second load is the
 * "next board load" that must not ask again. The fake-browser cases, including
 * the allow path a headless browser cannot click, are `device-context.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';

const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

interface Load {
  permission: string;
  outcome: string;
  calls: number;
  stored: string | null;
  cookie: string;
  echoed: string;
}
interface Reading {
  setting: string;
  first: Load;
  second: Load;
}

/** A launch and two loads per scenario, three scenarios. */
const BROWSER_CASE_MS = 180_000;

describe.skipIf(CHROME === null)('location consent in headless Chrome', () => {
  it(
    'granted writes a rounded fix that rides requests; denied and dismissed never ask twice',
    () => {
      const r = spawnSync('bun', [join(import.meta.dirname, 'device-context-driver.ts')], {
        encoding: 'utf8',
        timeout: BROWSER_CASE_MS - 10_000,
      });
      expect(r.status, r.stderr).toBe(0);
      const readings = JSON.parse(r.stdout) as Reading[];
      const by = (s: string) => readings.find((x) => x.setting === s);

      const granted = by('granted');
      expect(granted?.first.permission).toBe('granted');
      expect(granted?.first.echoed).toContain('cw_geo=10.12,-20.35');
      expect(granted?.second.echoed).toContain('cw_geo=10.12,-20.35');
      expect(granted?.first.stored).toBe('granted');

      const denied = by('denied');
      expect(denied?.first.calls).toBe(0);
      expect(denied?.second.calls).toBe(0);
      expect(denied?.second.echoed).not.toContain('cw_geo');
      // Positive control for the absence: the touch hint did ride the request.
      expect(denied?.second.echoed).toContain('cw_touch=');

      const dismissed = by('prompt');
      expect(dismissed?.first.outcome).toBe('asked');
      expect(dismissed?.first.calls).toBe(1);
      expect(dismissed?.first.stored).toBe('denied');
      expect(dismissed?.second.permission).toBe('prompt');
      expect(dismissed?.second.calls).toBe(1);
      expect(dismissed?.second.echoed).not.toContain('cw_geo');
    },
    BROWSER_CASE_MS,
  );
});
