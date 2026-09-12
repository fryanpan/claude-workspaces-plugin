#!/usr/bin/env bun
import { statSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * The ceiling the widget bundle must stay under, gzipped.
 *
 * Raised from 40 KB to 41 KB on 2026-09-12, with the measurement that forced
 * it. Every figure below is gzip LEVEL 9, which is what this gate compresses
 * with; a reading taken at zlib's default level 6 comes out about eighty
 * bytes high and is not comparable to anything here.
 *
 *   origin/main   40,940 gz   (133,102 raw)
 *   this branch   41,057 gz   (133,563 raw)
 *   old ceiling   40,960
 *
 * So main sat TWENTY bytes under the old ceiling, and the secret review-item
 * shape put 117 bytes on top of it: 103 for the secret branch of the payload
 * reader in `packages/core`, and 14 for the dock refusing to show an
 * owner-only ask on a host page.
 *
 * The widget ships no secret UI at all — it has no form, no copy and no
 * styles for one, and it never will, because a widget runs on other people's
 * pages. What it carries is the shared reader every surface parses a stored
 * payload through (`readReviewPayload`, reached from `schema.ts` because the
 * dock reads review items off the same CRDT the pins read). That reader is
 * also where a secret item is FORCED owner-only, on every read path at once,
 * which is the property the server's refusal rests on. The only ways to keep
 * those 103 bytes out of this bundle were to split that funnel in two or to
 * fork it per-bundle with a build shim, and a security funnel that behaves
 * one way in the widget and another way everywhere else is worth more than a
 * kilobyte.
 *
 * At twenty bytes the gate had stopped being a budget and become a tripwire
 * on the next change to `packages/core`, whatever it was. One kilobyte, not a
 * round-up to the next comfortable number, because the point of the gate is
 * that somebody has to come back here and write a paragraph. The widget is
 * injected into other people's pages; its size is a constraint on them, not
 * on us.
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
