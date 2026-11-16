#!/usr/bin/env bun
/**
 * Build the page client (`src/client/index.ts`, with Yjs inside) into two
 * prebuilt files for an app with no bundler:
 *
 *   cw-collab.js   a classic script: `<script src="/cw-collab.js">` defines
 *                  `window.cwCollab`
 *   cw-collab.mjs  the same exports as an ES module
 *
 * `bun run --cwd packages/app-kit build:client [outDir]` (default `dist/`).
 * `scripts/pack.ts` runs it, so the tarball carries both files; synchronous
 * because `packKit` is. esbuild, not
 * Bun.build, so the tests can run it under Node.
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { type BuildOptions, buildSync } from 'esbuild';

const PKG_ROOT = resolve(import.meta.dirname, '..');
const ENTRY = join(PKG_ROOT, 'src/client/index.ts');

/** The global the classic script defines. */
export const CLIENT_GLOBAL = 'cwCollab';
export const CLIENT_FILES = { iife: 'cw-collab.js', esm: 'cw-collab.mjs' } as const;

export interface BuiltClient {
  iife: string;
  esm: string;
}

export function buildClient(outDir: string): BuiltClient {
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const common: BuildOptions = {
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    target: 'es2020',
    platform: 'browser',
    legalComments: 'none',
    logLevel: 'silent',
  };
  const built: BuiltClient = {
    iife: join(out, CLIENT_FILES.iife),
    esm: join(out, CLIENT_FILES.esm),
  };
  buildSync({ ...common, format: 'iife', globalName: CLIENT_GLOBAL, outfile: built.iife });
  buildSync({ ...common, format: 'esm', outfile: built.esm });
  return built;
}

/** Bytes on disk and gzipped, for the size line a PR reports. */
export function sizeOf(path: string): { bytes: number; gzip: number } {
  return { bytes: statSync(path).size, gzip: gzipSync(readFileSync(path), { level: 9 }).length };
}

if (import.meta.main) {
  const built = buildClient(process.argv[2] ?? join(PKG_ROOT, 'dist'));
  for (const path of [built.iife, built.esm]) {
    const s = sizeOf(path);
    console.log(`${path}: ${s.bytes} bytes, ${s.gzip} gzipped`);
  }
}
