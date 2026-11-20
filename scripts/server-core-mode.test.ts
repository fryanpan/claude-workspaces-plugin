/**
 * Core mode's file list (`server-core-mode.ts`): it leaves out exactly the
 * switch's own tests, every one of which still exists, and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { CORE_MODE_ENV, CORE_MODE_SKIPS, coreModeFiles } from './server-core-mode.ts';
import { REPO_ROOT, SUITE_DIR, discover } from './test-server.ts';

describe('coreModeFiles', () => {
  it('leaves out the skipped files and keeps every other one, against the real suite', () => {
    const all = discover(REPO_ROOT, SUITE_DIR);
    const kept = coreModeFiles(all, all);
    const skipped = Object.keys(CORE_MODE_SKIPS);
    expect(kept.length).toBe(all.length - skipped.length);
    for (const f of skipped) expect(kept).not.toContain(f);
    // The control that runs in core mode is not one of them.
    expect(kept).toContain('packages/server/test/collab-core-mode.test.ts');
  });

  it('refuses a skip naming a file the suite no longer has', () => {
    const all = ['packages/server/test/harborlight.test.ts'];
    expect(() => coreModeFiles(all, all)).toThrow(/no longer has/);
  });

  it('turns the default on for the test processes', () => {
    expect(CORE_MODE_ENV.CW_COLLAB_CORE_DEFAULT).toBe('on');
  });
});
