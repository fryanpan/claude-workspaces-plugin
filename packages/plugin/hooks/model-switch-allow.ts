#!/usr/bin/env bun
/**
 * PreModelSwitch hook: lets `/model <name>` through with no question in a
 * lead's session, so the board can switch a lead nobody is sitting at. Logic
 * lives in `lib/model-report.ts`. Always exits 0; no output leaves Claude
 * Code's usual question in place.
 */
import { allowSwitch } from './lib/model-report.ts';

try {
  const answer = allowSwitch(JSON.parse(await Bun.stdin.text()));
  if (answer) process.stdout.write(answer);
} catch {
  // fail open
}
process.exit(0);
