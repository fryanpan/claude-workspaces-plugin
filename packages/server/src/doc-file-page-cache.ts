import type { BigIntStats } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * Built framed pages (`doc-file-frame.ts` `frameHtml`), kept so a reload does
 * not read and base64 every script again.
 *
 * The caller's key carries everything that decides whether the page may be
 * served at all: the decoded path, the serving folder, and the folder
 * listing's generation (`doc-file-listing.ts`), so a page whose folder stops
 * being framed, or whose files stop being listed, is never answered from
 * here. This module only decides whether the files are still the ones the
 * page was built from: each file's size and mtime, re-read off the main
 * thread and at most once per `PAGE_RECHECK.ms` per page.
 *
 * Bounded by total bytes (`PAGE_CACHE_LIMIT`), least recently used out
 * first. Concurrent asks for one key share one build.
 */

/** The most built pages held, in bytes; an object so a test can lower it. */
export const PAGE_CACHE_LIMIT = { bytes: 64 * 1024 * 1024 };
/** How long a hit is served before its files are stat'd again; a test lowers it. */
export const PAGE_RECHECK = { ms: 1_000 };

type Body = Uint8Array<ArrayBuffer>;
interface Dep {
  abs: string;
  size: bigint;
  mtimeNs: bigint;
}
interface Entry {
  deps: Dep[];
  body: Body;
  checkedAt: number;
}

const pages = new Map<string, Entry>();
const building = new Map<string, Promise<Body | null>>();
let held = 0;
let builds = 0;
let checks = 0;

/** How many pages have been built since boot; read by the tests. */
export const pageBuildCount = (): number => builds;
/** How many times a hit's files were stat'd again; read by the tests. */
export const pageCheckCount = (): number => checks;
/** The bytes the cache holds; read by the tests. */
export const pageCacheBytes = (): number => held;

async function stillCurrent(entry: Entry): Promise<boolean> {
  if (Date.now() - entry.checkedAt < PAGE_RECHECK.ms) return true;
  checks++;
  const same = await Promise.all(
    entry.deps.map((d) =>
      stat(d.abs, { bigint: true }).then(
        (st) => st.size === d.size && st.mtimeNs === d.mtimeNs,
        () => false,
      ),
    ),
  );
  if (!same.every(Boolean)) return false;
  entry.checkedAt = Date.now();
  return true;
}

function drop(key: string): void {
  const entry = pages.get(key);
  if (!entry) return;
  held -= entry.body.byteLength;
  pages.delete(key);
}

function store(key: string, entry: Entry): void {
  drop(key);
  if (entry.body.byteLength > PAGE_CACHE_LIMIT.bytes) return;
  pages.set(key, entry);
  held += entry.body.byteLength;
  while (held > PAGE_CACHE_LIMIT.bytes) {
    const oldest = pages.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
}

/**
 * The built page for `key`, from the cache while `page` and every file
 * written into it keep their size and mtime; otherwise built by `build`,
 * which reports each file it read with `note`, and calls `miss` for a file
 * the folder could hold but does not, so the page is built again rather than
 * served without it once it appears. Null when the page is too large.
 */
export async function cachedPage(
  key: string,
  page: { abs: string; st: BigIntStats },
  build: (note: (abs: string, st: BigIntStats) => void, miss: () => void) => Promise<Body | null>,
): Promise<Body | null> {
  const hit = pages.get(key);
  if (hit) {
    if (await stillCurrent(hit)) {
      // Most recently used goes last, unless it was replaced meanwhile.
      if (pages.get(key) === hit) {
        pages.delete(key);
        pages.set(key, hit);
      }
      return hit.body;
    }
    if (pages.get(key) === hit) drop(key);
  }
  const running = building.get(key);
  if (running) return running;
  const run = (async () => {
    const deps: Dep[] = [{ abs: page.abs, size: page.st.size, mtimeNs: page.st.mtimeNs }];
    builds++;
    let complete = true;
    const body = await build(
      (abs, st) => deps.push({ abs, size: st.size, mtimeNs: st.mtimeNs }),
      () => {
        complete = false;
      },
    );
    if (body !== null && complete) store(key, { deps, body, checkedAt: Date.now() });
    return body;
  })().finally(() => building.delete(key));
  building.set(key, run);
  return run;
}
