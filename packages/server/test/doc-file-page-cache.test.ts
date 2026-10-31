/**
 * The built-page cache: bounded by bytes, one build per key at a time, and a
 * hit's files re-stat'd at most once per recheck window.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAGE_CACHE_LIMIT,
  PAGE_RECHECK,
  cachedPage,
  pageBuildCount,
  pageCacheBytes,
  pageCheckCount,
} from '../src/doc-file-page-cache.ts';

describe('cachedPage', () => {
  let root: string;
  let file: string;
  const saved = { bytes: PAGE_CACHE_LIMIT.bytes, ms: PAGE_RECHECK.ms };
  const page = () => ({ abs: file, st: statSync(file, { bigint: true }) });
  const body = (n: number) => new Uint8Array(new ArrayBuffer(n));

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'doc-file-page-cache-'));
    file = join(root, 'index.html');
    writeFileSync(file, '<h1>Harborlight</h1>');
  });
  afterEach(() => {
    PAGE_CACHE_LIMIT.bytes = saved.bytes;
    PAGE_RECHECK.ms = saved.ms;
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('shares one build between concurrent asks for a key', async () => {
    let calls = 0;
    const build = async () => {
      calls++;
      await Promise.resolve();
      return body(10);
    };
    const [a, b] = await Promise.all([
      cachedPage('shared', page(), build),
      cachedPage('shared', page(), build),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it('holds no more than its byte limit, dropping the least recently used', async () => {
    PAGE_CACHE_LIMIT.bytes = 250;
    const start = pageBuildCount();
    for (const key of ['cap-a', 'cap-b', 'cap-c']) {
      await cachedPage(key, page(), async () => body(100));
    }
    expect(pageCacheBytes()).toBeLessThanOrEqual(250);
    expect(pageBuildCount()).toBe(start + 3);
    // `cap-c` is held; `cap-a` was dropped and builds again.
    await cachedPage('cap-c', page(), async () => body(100));
    expect(pageBuildCount()).toBe(start + 3);
    await cachedPage('cap-a', page(), async () => body(100));
    expect(pageBuildCount()).toBe(start + 4);
  });

  it('re-stats a hit only once its recheck window has passed', async () => {
    PAGE_RECHECK.ms = 60_000;
    await cachedPage('ttl', page(), async () => body(10));
    const checks = pageCheckCount();
    await cachedPage('ttl', page(), async () => body(10));
    await cachedPage('ttl', page(), async () => body(10));
    expect(pageCheckCount()).toBe(checks);
    PAGE_RECHECK.ms = 0;
    await cachedPage('ttl', page(), async () => body(10));
    expect(pageCheckCount()).toBe(checks + 1);
  });
});
