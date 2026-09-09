/**
 * The checkout-row half of the registry, driven directly.
 *
 * Every assertion here is about a row's CONTENT after a transition, because
 * the rule the feature rests on is that nothing is ever dropped: a retired
 * checkout keeps its row so the documents reviewed in it keep resolving.
 *
 * Fixtures are synthetic paths; nothing is read from disk except by
 * `liveCheckouts`, which is given real directories.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findCheckoutRecord,
  liveCheckouts,
  retireCheckout,
  touchCheckout,
} from '../src/repo-registry-checkouts.ts';
import type { RepoRecord, RepoRegistryFile } from '../src/repo-registry-file.ts';

function repo(mainRoot: string): RepoRecord {
  return { repoKey: 'git:example.test/plan', aliasKeys: [], mainRoot, checkouts: [] };
}

describe('repo checkout rows', () => {
  it('adds a row the first time and only moves lastSeenAt after that', () => {
    const r = repo('/repos/plan');
    const first = touchCheckout(r, '/repos/plan-wt', false, 1000);
    expect(r.checkouts).toHaveLength(1);
    expect(first.addedAt).toBe(1000);

    const again = touchCheckout(r, '/repos/plan-wt', false, 2000);
    expect(r.checkouts).toHaveLength(1);
    expect(again.addedAt).toBe(1000);
    expect(again.lastSeenAt).toBe(2000);
    // A bind is not vouching: seeing a checkout never registers it.
    expect(again.registered).toBe(false);
  });

  it('registering again un-retires the row a lead retired', () => {
    const r = repo('/repos/plan');
    touchCheckout(r, '/repos/plan-wt', true, 1000);
    const data: RepoRegistryFile = { version: 1, repos: [r], docKeys: {}, docKeyAliases: {} };
    expect(retireCheckout(data, '/repos/plan-wt', 2000)).toEqual({
      ok: true,
      repoKey: 'git:example.test/plan',
    });
    expect(r.checkouts[0]?.removedAt).toBe(2000);
    expect(r.checkouts[0]?.registered).toBe(false);

    touchCheckout(r, '/repos/plan-wt', true, 3000);
    expect(r.checkouts[0]?.removedAt).toBeUndefined();
    expect(r.checkouts[0]?.registered).toBe(true);
    // CONTROL: a plain sighting does NOT un-retire, so the clearing above is
    // the lead's act and not a side effect of being seen.
    retireCheckout(data, '/repos/plan-wt', 4000);
    touchCheckout(r, '/repos/plan-wt', false, 5000);
    expect(r.checkouts[0]?.removedAt).toBe(4000);
  });

  it('retiring keeps the row, and finding one writes nothing', () => {
    const r = repo('/repos/plan');
    touchCheckout(r, '/repos/plan-wt', true, 1000);
    const data: RepoRegistryFile = { version: 1, repos: [r], docKeys: {}, docKeyAliases: {} };
    retireCheckout(data, '/repos/plan-wt', 2000);
    // The row survives its own retirement: this is what keeps a doc reviewed
    // in a removed worktree resolvable.
    expect(findCheckoutRecord(data, '/repos/plan-wt')).toEqual({
      repoKey: 'git:example.test/plan',
      root: '/repos/plan-wt',
    });
    expect(retireCheckout(data, '/repos/never-seen', 3000)).toEqual({ ok: false });
    expect(findCheckoutRecord(data, '/repos/never-seen')).toBeNull();
    // And the failed lookups changed nothing.
    expect(r.checkouts).toHaveLength(1);
  });

  it('lists only checkouts that still exist, and never a retired one', () => {
    const base = mkdtempSync(join(tmpdir(), 'cw-checkouts-'));
    try {
      const r = repo(join(base, 'plan'));
      touchCheckout(r, base, true, 1000);
      touchCheckout(r, join(base, 'gone'), true, 1000);
      // A directory that exists but whose row was retired.
      touchCheckout(r, base, true, 1000);
      expect(liveCheckouts(r)).toEqual([base]);

      const data: RepoRegistryFile = { version: 1, repos: [r], docKeys: {}, docKeyAliases: {} };
      retireCheckout(data, base, 2000);
      expect(liveCheckouts(r)).toEqual([]);
      // CONTROL: an unknown repo lists nothing rather than throwing.
      expect(liveCheckouts(undefined)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
