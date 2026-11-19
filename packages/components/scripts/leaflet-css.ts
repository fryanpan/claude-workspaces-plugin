#!/usr/bin/env bun
/**
 * Writes `src/leaflet-css.ts`: Leaflet's stylesheet as a string the map
 * component puts on the page itself, so a site needs no `<link>` and a doc
 * needs no copy served beside it. `bun run --cwd packages/components
 * leaflet-css` after a Leaflet upgrade; `--check` exits 1 when the committed
 * file is not what this would write.
 *
 * Comments and runs of whitespace go, and so does every declaration naming a
 * `url(…)`: they are the layers control's and default marker's images and
 * old IE's VML behaviour, none of which this map uses, and a relative image
 * path would resolve against the host page.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const PKG_ROOT = resolve(import.meta.dirname, '..');
const OUT = join(PKG_ROOT, 'src', 'leaflet-css.ts');

/** Leaflet's stylesheet, compacted, as the generated module's text. */
export function leafletCssModule(): string {
  const require = createRequire(join(PKG_ROOT, 'package.json'));
  const version = (require('leaflet/package.json') as { version: string }).version;
  const css = readFileSync(require.resolve('leaflet/dist/leaflet.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/[^;{}]*url\([^)]*\)[^;{}]*;?/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,>])\s*/g, '$1')
    .trim();
  return `/**
 * Leaflet ${version}'s stylesheet, compacted. Written by
 * \`scripts/leaflet-css.ts\`; do not edit by hand.
 */
export const LEAFLET_CSS: string = ${JSON.stringify(css)};
`;
}

if (import.meta.main) {
  const text = leafletCssModule();
  if (process.argv.includes('--check')) {
    const held = readFileSync(OUT, 'utf8');
    if (held !== text) {
      console.error(`${OUT} is stale: run bun run --cwd packages/components leaflet-css`);
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, text);
    console.log(OUT);
  }
}
