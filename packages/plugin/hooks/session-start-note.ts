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
 * Reads no stdin and makes no network call: the instance this exists for is
 * the one with no board, so anything that needed a board would inherit the
 * bug. Writes one line of JSON on stdout when there is something to say and
 * NOTHING when the session is configured. Always exits 0 — the reasoning is
 * `lib/session-report.ts`.
 */
import { sessionStartOutput, sessionStartReport } from './lib/session-report.ts';

try {
  const report = sessionStartReport(process.env);
  if (report) process.stdout.write(`${sessionStartOutput(report.text)}\n`);
} catch {
  // fail open
}
process.exit(0);
