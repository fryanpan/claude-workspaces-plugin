/**
 * Home names its entry's static chunks as modulepreloads, so they download
 * beside the entry rather than after it.
 *
 * The landing bundle is split, so its entry is a loader that imports shared
 * chunks. Without the links the browser fetched the page, then the entry,
 * then the chunks: three requests in series before Home's script ran.
 *
 * Driven through a real server and a dist laid out the way the build lays it
 * out — a manifest naming a content-addressed entry, which imports one chunk
 * statically and one lazily. The lazy one must stay off the list: preloading
 * it would put back the bytes splitting took off the first load.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

let dir: string;
let handle: ServerHandle;
let base: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'landing-preload-'));
  const dist = join(dir, 'app');
  mkdirSync(dist);
  writeFileSync(
    join(dist, 'asset-manifest.json'),
    JSON.stringify({ 'landing.js': 'landing-0123456789abcdef.js' }),
  );
  writeFileSync(
    join(dist, 'landing-0123456789abcdef.js'),
    'import{a as b}from"./landing-app-aaaa1111.js";const l=()=>import("./lazy-bbbb2222.js");b();',
  );
  writeFileSync(join(dist, 'landing-app-aaaa1111.js'), 'import"./shared-cccc3333.js";');
  writeFileSync(join(dist, 'shared-cccc3333.js'), 'export const a=1;');
  handle = createServer({ port: 0, dataDir: join(dir, 'data'), markdownAppDistDir: dist });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** The modulepreload hrefs in a page, in order. */
const preloadsOf = (html: string): string[] =>
  [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1] ?? '');

describe('Home preloads its entry’s chunks', () => {
  it('names every static chunk, through each other, and no lazy one', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('src="/app/landing-0123456789abcdef.js"');
    expect(preloadsOf(html)).toEqual(['/app/landing-app-aaaa1111.js', '/app/shared-cccc3333.js']);
  });
});
