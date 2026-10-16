#!/usr/bin/env bun
/**
 * UserPromptSubmit hook for the claude-workspaces plugin.
 *
 * Posts one mark per prompt saying whether a person typed it, so the coach
 * counts the owner's Claude Code time from his own prompts and not from
 * channel wakes; a typed one carries its text, reduced. Prints
 * nothing (this hook's stdout would join the model's context) and always
 * exits 0. Logic lives in `lib/prompt-mark.ts`.
 */
import { discoveryPort } from './lib/hook-main.ts';
import { runPromptHook } from './lib/prompt-mark.ts';

try {
  await runPromptHook(await Bun.stdin.text(), {
    env: process.env,
    discoveryPort,
    joinedBoard: true,
  });
} catch {
  // fail open
}
process.exit(0);
