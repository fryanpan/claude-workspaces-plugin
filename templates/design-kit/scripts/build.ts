#!/usr/bin/env bun
/**
 * Build the trial into dist/: the kit's script, the Preact page's script, the
 * shared kit stylesheet and one stylesheet per theme file. Minified, because
 * the bundle size is one of the things this trial measures.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const KIT_ROOT = join(import.meta.dirname, '..');
export const DIST = join(KIT_ROOT, 'dist');

export function themeNames(): string[] {
  return readdirSync(join(KIT_ROOT, 'themes'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => f.slice(0, -'.css'.length))
    .sort();
}

async function buildOrThrow(config: Parameters<typeof Bun.build>[0]): Promise<void> {
  const out = await Bun.build(config);
  if (!out.success) {
    for (const log of out.logs) console.error(log);
    throw new Error(`build failed for ${config.entrypoints.join(', ')}`);
  }
}

export async function buildKit(): Promise<void> {
  rmSync(DIST, { recursive: true, force: true });
  await buildOrThrow({
    entrypoints: [join(KIT_ROOT, 'src/kit.ts'), join(KIT_ROOT, 'src/tasks.tsx')],
    outdir: DIST,
    target: 'browser',
    format: 'esm',
    minify: true,
  });
  await buildOrThrow({
    entrypoints: [join(KIT_ROOT, 'src/kit.css')],
    outdir: DIST,
    minify: true,
  });
  await buildOrThrow({
    entrypoints: themeNames().map((t) => join(KIT_ROOT, 'themes', `${t}.css`)),
    outdir: join(DIST, 'themes'),
    minify: true,
  });
}

if (import.meta.main) {
  await buildKit();
  console.log(`built ${DIST}: ${readdirSync(DIST).join(', ')}`);
}
