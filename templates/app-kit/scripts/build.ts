#!/usr/bin/env bun
/**
 * Build the client into dist/: `main.js` (the page script), `app.css` (the
 * app's styles) and `theme.css` (the shared theme). Each stylesheet is
 * bundled, because its base `@import`s come out of node_modules and the
 * served file must stand alone.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
export const DIST = join(ROOT, 'dist');

export async function build(): Promise<void> {
  rmSync(DIST, { recursive: true, force: true });
  const out = await Bun.build({
    entrypoints: [
      join(ROOT, 'src/client/main.ts'),
      join(ROOT, 'src/app.css'),
      join(ROOT, 'src/theme.css'),
    ],
    outdir: DIST,
    target: 'browser',
    format: 'esm',
    minify: true,
    naming: '[name].[ext]',
  });
  if (!out.success) {
    for (const log of out.logs) console.error(log);
    throw new Error('build failed');
  }
}

if (import.meta.main) {
  await build();
  console.log(`built ${DIST}: ${readdirSync(DIST).sort().join(', ')}`);
}
