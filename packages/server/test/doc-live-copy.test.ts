import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * AC3, AC4 and AC5 through the store: the live copy is recorded, another
 * checkout's differing copy raises a drift flag with a counter, and two
 * copies edited at once produce a candidate table rather than a guess.
 *
 * All fixtures are synthetic.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

function setMtime(path: string, epochSeconds: number): void {
  utimesSync(path, epochSeconds, epochSeconds);
}

describe('DocStore.resolveLiveCopy', () => {
  let tmp: string;
  let main: string;
  let wt: string;
  let store: DocStore;
  let docId: string;
  const rel = 'docs/plan.md';
  const T0 = 1_788_912_000;

  beforeEach(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-live-')));
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir);
    main = join(tmp, 'repo');
    mkdirSync(main);
    git(main, 'init', '-b', 'main');
    git(main, 'remote', 'add', 'origin', 'git@github.com:example/widgets.git');
    mkdirSync(join(main, 'docs'));
    writeFileSync(join(main, rel), '# Plan\n\nshared\n');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'init');
    wt = join(tmp, 'wt-feature');
    git(main, 'worktree', 'add', wt, '-b', 'feature');
    store = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m }),
    });
    const created = store.createForCaller('plan', {
      type: 'markdown',
      sourceUrl: join(main, rel),
    });
    if (!created.ok) throw new Error('fixture failed to create the doc');
    docId = created.doc.docId;
    await store.attachFileAsync(docId, join(main, rel));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('records the checkout whose copy was edited most recently', () => {
    writeFileSync(join(wt, rel), '# Plan\n\nedited on the branch\n');
    setMtime(join(main, rel), T0);
    setMtime(join(wt, rel), T0 + 600);
    const res = store.resolveLiveCopy(docId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.live).toBe(join(wt, rel));
    expect(store.get(docId)?.meta.liveCheckout).toBe(wt);
    expect(res.retargeted).toBe(true);
    expect(store.boundPathOf(docId)).toBe(join(wt, rel));
  });

  it('CONTROL: leaves the binding alone when the bound copy is the newest', () => {
    writeFileSync(join(wt, rel), '# Plan\n\nolder branch copy\n');
    setMtime(join(wt, rel), T0);
    setMtime(join(main, rel), T0 + 600);
    const res = store.resolveLiveCopy(docId);
    if (!res.ok) return;
    expect(res.retargeted).toBe(false);
    expect(store.boundPathOf(docId)).toBe(join(main, rel));
  });

  it('flags drift and counts each entry into it, not each look', () => {
    writeFileSync(join(wt, rel), '# Plan\n\ndifferent on the branch\n');
    setMtime(join(wt, rel), T0);
    setMtime(join(main, rel), T0 + 600);

    const first = store.resolveLiveCopy(docId);
    if (!first.ok) return;
    expect(first.drift).toEqual([wt]);
    expect(store.get(docId)?.meta.driftFirings).toBe(1);
    const firstSeenAt = store.get(docId)?.meta.driftCheckouts?.[0]?.firstSeenAt;
    expect(firstSeenAt).toBeGreaterThan(0);

    // Looking again at the same disagreement is not a second firing, and the
    // moment it was first seen does not move.
    store.resolveLiveCopy(docId);
    expect(store.get(docId)?.meta.driftFirings).toBe(1);
    expect(store.get(docId)?.meta.driftCheckouts?.[0]?.firstSeenAt).toBe(firstSeenAt as number);

    // Resolve the disagreement: the flag clears, the lifetime count does not.
    writeFileSync(join(wt, rel), '# Plan\n\nshared\n');
    setMtime(join(wt, rel), T0);
    const cleared = store.resolveLiveCopy(docId);
    if (!cleared.ok) return;
    expect(cleared.drift).toEqual([]);
    expect(store.get(docId)?.meta.driftCheckouts).toBeUndefined();
    expect(store.get(docId)?.meta.driftFirings).toBe(1);

    // And drifting again counts a second time.
    writeFileSync(join(wt, rel), '# Plan\n\ndifferent again\n');
    setMtime(join(wt, rel), T0);
    store.resolveLiveCopy(docId);
    expect(store.get(docId)?.meta.driftFirings).toBe(2);
  });

  it('refuses with a candidate table when two copies were edited at once', () => {
    writeFileSync(join(wt, rel), '# Plan\n\nbranch edit\n');
    writeFileSync(join(main, rel), '# Plan\n\nmain edit\n');
    setMtime(join(main, rel), T0);
    setMtime(join(wt, rel), T0 + 1);
    const res = store.resolveLiveCopy(docId, { withGitStatus: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    if (res.error !== 'ambiguous-copy') throw new Error(`unexpected error ${res.error}`);
    expect(res.candidates.map((c) => c.root).sort()).toEqual([main, wt].sort());
    expect(res.candidates.every((c) => typeof c.branch === 'string')).toBe(true);
    // Nothing was written while it was ambiguous.
    expect(store.get(docId)?.meta.liveCheckout).toBeUndefined();
    expect(store.boundPathOf(docId)).toBe(join(main, rel));
  });

  it('takes the pick and stops asking', () => {
    writeFileSync(join(wt, rel), '# Plan\n\nbranch edit\n');
    writeFileSync(join(main, rel), '# Plan\n\nmain edit\n');
    setMtime(join(main, rel), T0);
    setMtime(join(wt, rel), T0 + 1);
    const picked = store.resolveLiveCopy(docId, { checkout: wt });
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.live).toBe(join(wt, rel));
    expect(store.get(docId)?.meta.liveCheckout).toBe(wt);
  });

  it('ignores a pick that names a checkout with no copy in it', () => {
    // The person chose a checkout; if it holds no file, honouring the pick
    // would park the doc, which is not what they chose.
    writeFileSync(join(wt, rel), '# Plan\n\nbranch edit\n');
    setMtime(join(wt, rel), T0);
    setMtime(join(main, rel), T0 + 600);
    const res = store.resolveLiveCopy(docId, { checkout: join(tmp, 'nowhere') });
    if (!res.ok) return;
    expect(res.live).toBe(join(main, rel));
  });

  it('parks rather than failing when the file exists in no checkout', () => {
    rmSync(join(main, rel));
    rmSync(join(wt, rel));
    const res = store.resolveLiveCopy(docId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.live).toBeNull();
    // The .ydoc is still the durable record, so the doc itself is intact.
    expect(store.get(docId)).toBeDefined();
  });

  it('says so for a doc that has no repo identity at all', () => {
    const loose = join(tmp, 'loose.md');
    writeFileSync(loose, '# Loose\n');
    const created = store.createForCaller('loose', { type: 'markdown', sourceUrl: loose });
    if (!created.ok) return;
    const res = store.resolveLiveCopy(created.doc.docId);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('no-key');
  });
});
