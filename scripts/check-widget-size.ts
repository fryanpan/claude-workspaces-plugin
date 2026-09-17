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
 * Which left main's own margin as the thing worth knowing — six bytes under
 * the ceiling, and this gate a tripwire on the next change to `packages/core`,
 * whatever that change was about.
 *
 * The room came back without moving the number (2026-09-12):
 *
 *   before        40,954 gz   (133,133 raw)
 *   after         38,818 gz   (126,623 raw)   2,142 under
 *
 * 1,844 of it was the widget reading `anchors.Element` off the core barrel. A
 * namespace object keeps every module behind it, so each embed carried
 * text-range anchors, their validator and the yjs position code they reach,
 * none of which an element pin calls. The other 292 was Bun building an export
 * object and CommonJS interop for an IIFE that has nowhere to put exports
 * (`packages/widget/src/widget-iife.ts`). The build now refuses a bundle that
 * holds any module it was measured without (`packages/widget/scripts/bundle-guard.ts`),
 * so that regrowth fails on the change that causes it, not on the next one.
 *
 * It had grown back to 40,945 on main by 2026-09-14, and the tailnet widget
 * door put it 36 over. The room came from the thread reader again:
 *
 *   before        40,996 gz   (132,148 raw)
 *   after         40,522 gz   (130,281 raw)   438 under
 *
 * The widget's copy of `listThreads` lifted nine fields no widget code reads
 * (a thread's summary and status attribution, a comment's edit trail and
 * attribution, and four answer and revision records on a review item). The
 * build cuts those statements (`packages/widget/scripts/strip-unread-fields.ts`)
 * and refuses a bundle that reads any of the nine, so a widget change that
 * starts showing one fails the build instead of reading `undefined`.
 *
 * And again on 2026-09-16, from the part of the bundle that was not about
 * reading anything:
 *
 *   before        40,733 gz   (130,819 raw)      227 under
 *   after         39,847 gz   (127,461 raw)    1,113 under
 *
 * 886 of it was `y-protocols/awareness`, plus the `lib0/time` behind it. The
 * widget renders presence nowhere — it reads `client.awareness` in no module —
 * and the two surfaces that DO render presence skip an entry carrying no
 * `user.name`, which is the only kind a widget has ever had. So no reader has
 * ever seen a widget in a presence strip, while every host page paid for the
 * protocol, announced an empty entry on each connect, and ran a 3-second
 * interval for the life of the page. The build stands a shim in for it
 * (`packages/widget/scripts/shims/y-protocols-awareness.ts`) and
 * `bundle-guard.ts` refuses a bundle that takes the real one back.
 *
 * Raising the ceiling is a decision about what the widget costs the pages it is
 * a guest on, so it takes a paragraph here, not a round-up.
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
