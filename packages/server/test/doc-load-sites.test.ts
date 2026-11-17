import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DocLoadSites,
  LOAD_SITE_CAP,
  currentLoadSite,
  formatLoads,
  loadSiteOf,
  loadsInWindow,
} from '../src/doc-load-sites.ts';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

describe('loadSiteOf', () => {
  it('names the first frame outside doc-store.ts, relative to packages/', () => {
    const stack = [
      'Error',
      '    at loadSite (/Users/x/repo/packages/server/src/doc-load-sites.ts:40:12)',
      '    at getOrCreate (/Users/x/repo/packages/server/src/doc-store.ts:2310:9)',
      '    at resolveDoc (/Users/x/repo/packages/server/src/doc-store.ts:2400:5)',
      '    at <anonymous> (/Users/x/repo/packages/server/src/home-pane.ts:122:41)',
      '    at sized (/Users/x/repo/packages/server/src/review-sizing.ts:100:20)',
    ].join('\n');
    expect(loadSiteOf(stack)).toBe('packages/server/src/home-pane.ts:122');
  });

  it('says external when no frame is under packages/, and unknown with no stack', () => {
    expect(loadSiteOf('Error\n    at x (node:internal/foo:1:1)')).toBe('external');
    expect(loadSiteOf(undefined)).toBe('unknown');
  });

  it('reads this very call site from a live stack', () => {
    expect(currentLoadSite()).toMatch(/^packages\/server\/test\/doc-load-sites\.test\.ts:\d+$/);
  });
});

describe('DocLoadSites', () => {
  it('counts by site and folds sites past the cap into other', () => {
    let next = 'a';
    const sites = new DocLoadSites(() => next);
    sites.record();
    sites.record();
    for (let i = 0; i < LOAD_SITE_CAP + 3; i++) {
      next = `s${i}`;
      sites.record();
    }
    const { loads, loadsTotal } = sites.stats();
    expect(loadsTotal).toBe(LOAD_SITE_CAP + 5);
    expect(loads[0]).toEqual({ tag: 'other', count: 4 });
    expect(loads.find((l) => l.tag === 'a')?.count).toBe(2);
    expect(loads.length).toBe(LOAD_SITE_CAP + 1);
    expect(loads.reduce((n, l) => n + l.count, 0)).toBe(loadsTotal);
  });
});

describe('the window', () => {
  it('is the growth since the previous read, busiest first', () => {
    const w = loadsInWindow(
      {
        loads: [
          { tag: 'a', count: 10 },
          { tag: 'b', count: 9 },
          { tag: 'c', count: 1 },
        ],
        loadsTotal: 20,
      },
      new Map([
        ['a', 9],
        ['b', 2],
        ['c', 1],
      ]),
      12,
    );
    expect(w).toEqual({
      loaded: 8,
      by: [
        { tag: 'b', count: 7 },
        { tag: 'a', count: 1 },
      ],
    });
  });

  it('prints five sites and counts the rest', () => {
    const by = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((tag, i) => ({ tag, count: 7 - i }));
    expect(formatLoads({ loaded: 28, by })).toBe(' loaded=+28 by=a*7,b*6,c*5,d*4,e*3,+2more');
    expect(formatLoads({ loaded: 0, by: [] })).toBe(' loaded=+0 by=none');
  });
});

describe('DocStore records the caller that loaded each doc', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  const open = (dataDir: string) =>
    new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });

  it('names this test file for a doc it loads cold, and nothing for a resident read', () => {
    dir = mkdtempSync(join(tmpdir(), 'cw-load-sites-'));
    const first = open(dir);
    first.getOrCreate('harborlight-notes', { type: 'markdown', title: 'Harborlight' });
    first.flush();
    first.stop();

    const store = open(dir);
    try {
      const before = store.stats().loadsTotal;
      store.getForRead('harborlight-notes');
      store.getForRead('harborlight-notes');
      const after = store.stats();
      expect(after.loadsTotal).toBe(before + 1);
      const site = after.loads.find((l) => l.tag.includes('doc-load-sites.test.ts'));
      expect(site?.count).toBe(1);
    } finally {
      store.stop();
    }
  });
});
