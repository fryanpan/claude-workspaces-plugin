#!/usr/bin/env bun
/**
 * SessionStart, Stop, PostModelSwitch, PreCompact and PostCompact hook: tells
 * the board what a lead's session runs on, and when it is compacting. Prints
 * nothing and always exits 0. Logic lives in `lib/model-report.ts`.
 */
import { discoveryPort } from './lib/hook-main.ts';
import { runModelReport } from './lib/model-report.ts';

try {
  await runModelReport(await Bun.stdin.text(), {
    env: process.env,
    discoveryPort,
    joinedBoard: true,
  });
} catch {
  // fail open
}
process.exit(0);
