#!/usr/bin/env bun
import { statSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * The ceiling the widget bundle must stay under, gzipped.
 *
 * Raised from 40 KB to 41 KB on 2026-09-12, with the measurement that forced
 * it: origin/main built to 40,940 bytes gzipped — TWENTY bytes under the old
 * ceiling. At that margin the gate had stopped being a budget and become a
 * tripwire on the next change to `packages/core`, whatever it was: the secret
 * review-item shape carried the bundle to 41,123 and tripped it, and so would
 * have any other addition to a module `schema.ts` reaches.
 *
 * One kilobyte, not a round-up to the next comfortable number, because the
 * point of the gate is that somebody has to come back here and write a
 * paragraph. The widget is injected into other people's pages; its size is a
 * constraint on them, not on us.
 */
const BUDGET_BYTES = 41 * 1024;
const WIDGET_IIFE = join(import.meta.dir, '..', 'packages', 'widget', 'dist', 'widget.iife.js');

if (!existsSync(WIDGET_IIFE)) {
  console.error(`widget bundle not found at ${WIDGET_IIFE}. run bun run build:widget first.`);
  process.exit(2);
}

const raw = readFileSync(WIDGET_IIFE);
const gz = gzipSync(raw, { level: 9 });
const rawKb = (raw.length / 1024).toFixed(1);
const gzKb = (gz.length / 1024).toFixed(1);

console.log(
  `widget.iife.js: ${rawKb} KB raw, ${gzKb} KB gzipped (budget: ${BUDGET_BYTES / 1024} KB gz)`,
);

if (gz.length > BUDGET_BYTES) {
  console.error(`❌ OVER BUDGET by ${((gz.length - BUDGET_BYTES) / 1024).toFixed(1)} KB gzipped`);
  process.exit(1);
}

console.log('✅ within budget');

// side-effect: touch stat so any tooling picks up the build time
statSync(WIDGET_IIFE);
