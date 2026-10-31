#!/usr/bin/env bun
/**
 * MessageDisplay and PostToolBatch hook for the claude-workspaces plugin.
 *
 * Hands the board's lead chat the text the lead's session writes mid-turn
 * and the tool calls it makes, so the chat shows what its terminal shows.
 * Posts nothing for a session the server has not said is the lead. Prints
 * nothing (a MessageDisplay hook's output would replace what the terminal
 * shows) and always exits 0. Logic lives in `lib/session-mirror.ts`.
 */
import { discoveryPort } from './lib/hook-main.ts';
import { runMirrorHook } from './lib/session-mirror.ts';

try {
  await runMirrorHook(await Bun.stdin.text(), {
    env: process.env,
    discoveryPort,
    joinedBoard: true,
  });
} catch {
  // fail open
}
process.exit(0);
