#!/usr/bin/env bun
/**
 * SessionStart hook for the claude-workspaces plugin.
 *
 * Tells a session, in its own context, when the plugin's note hooks are
 * installed but cannot post anything — no `CW_WORKSPACE_ID`, no
 * `CW_AGENT_NAME`. Four fleet agents ran for weeks in exactly that state and
 * nobody noticed, because a hook that exits 0 with nothing to post is
 * indistinguishable from a quiet turn.
 *
 * Also sends the board rules: the marked regions of the
 * `working-in-a-workspace` skill (`lib/board-rules.ts`), so every session reads
 * them before its first turn. A skill reaches only a session that opens it.
 *
 * Reads no stdin and makes no network call: the instance this exists for is
 * the one with no board, so anything that needed a board would inherit the
 * bug. Writes one line of JSON on stdout. Always exits 0 — the reasoning is
 * `lib/session-report.ts`.
 */
import { readFileSync } from 'node:fs';
import { boardRulesText } from './lib/board-rules.ts';
import { sessionStartOutput, sessionStartReport } from './lib/session-report.ts';

const SKILL = new URL('../skills/working-in-a-workspace/SKILL.md', import.meta.url);

function rules(): string {
  try {
    const text = boardRulesText(readFileSync(SKILL, 'utf8'));
    if (text) return text;
    return '[claude-workspaces] The board rules are missing: the working-in-a-workspace skill marks no region.';
  } catch (err) {
    return `[claude-workspaces] The board rules could not be read (${String(err)}). Read the claude-workspaces:working-in-a-workspace skill.`;
  }
}

try {
  const report = sessionStartReport(process.env);
  const parts = report ? [report.text, rules()] : [rules()];
  process.stdout.write(`${sessionStartOutput(parts.join('\n\n'))}\n`);
} catch {
  // fail open
}
process.exit(0);
