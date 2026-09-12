#!/usr/bin/env bun
import { statSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * The ceiling the widget bundle must stay under, gzipped.
 *
 * Forty kilobytes, unmoved. It was raised to 41 KB earlier on this branch and
 * put back when the bundle fit again; what follows is what that cost and why
 * the number did not have to move.
 *
 * Every figure here is gzip LEVEL 9, which is what this gate compresses with.
 * A reading taken at zlib's default level 6 comes out about eighty bytes high
 * and is not comparable to anything here — measured, after a level-6 reading
 * put a branch 160 bytes over a ceiling it was 40 under.
 *
 *   origin/main   40,940 gz   (133,102 raw)
 *   this branch   40,954 gz   (133,133 raw)
 *   ceiling       40,960
 *
 * The secret review-item shape first landed 117 bytes on top of main: 103 for
 * reading that shape inside the payload reader every surface shares, and 14
 * for the dock refusing to show an owner-only ask on a host page. Only the 14
 * are left.
 *
 * The 103 went because the widget ships no secret UI at all — no form, no
 * copy, no styles — and never will, since a widget runs on other people's
 * pages and those values are typed on the board. It was carrying the READER:
 * `readReviewPayload`, reached from `schema.ts` because the dock reads review
 * items off the same CRDT the pins read. That reader is also where a secret
 * item is FORCED owner-only on every read path at once, which is the property
 * the server's refusal rests on, so the funnel could not simply be split in
 * two. What it could be is emptied for one bundle: the shape's reading sits in
 * its own module behind two guarded lines, and the widget's build deletes
 * those two lines from its copy (`packages/widget/scripts/strip-secret-shape.ts`,
 * which throws rather than ship a reader it could not find). Every surface
 * where a person could answer such an ask still reads the real thing.
 *
 * The 14 stay, and should: they are the dock declining to put an owner-only
 * ask, and an affordance for answering it, in front of readers the server
 * refuses.
 *
 * Which leaves main's own margin as the thing worth knowing — six bytes under
 * the ceiling now, twenty before. This gate is close to being a tripwire on
 * the next change to `packages/core`, whatever that change is about. Raising
 * it is a decision about what the widget costs the pages it is a guest on, so
 * it takes a paragraph here, not a round-up.
 */
const BUDGET_BYTES = 40 * 1024;
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
