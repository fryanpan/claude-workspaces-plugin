/**
 * The SessionStart report — what a session is told about its own plugin
 * configuration, once, at launch.
 *
 * Why it exists, measured: four of twelve fleet agents contributed nothing to
 * the end-of-turn note corpus for weeks. They had launched without
 * `CW_WORKSPACE_ID`, and the Stop hook exits 0 when there is no board —
 * correctly, because a hook must never block a turn. The consequence is that a
 * configured-but-INERT hook is indistinguishable from a session that simply had
 * quiet turns: nobody outside can tell, and nobody inside is told. It surfaced
 * only because a peer was asked an unrelated question and happened to check its
 * own environment.
 *
 * The principle this file is: **fail-open is right, fail-open AND SILENT never
 * is.** A component that can be configured but inert must say so.
 *
 * Three choices worth keeping:
 *
 *  - **It goes into the agent's own context, not stderr.** Hook stderr is read
 *    by somebody who already suspects a problem, which is exactly the
 *    population that does not need telling.
 *  - **It is a session event, not a per-turn one.** The condition is fixed at
 *    launch and has exactly one transition, so a per-turn line would write the
 *    same sentence hundreds of times and become a channel people skip.
 *  - **It is local.** A board-side note cannot reach an agent whose defect is
 *    having no board — a destination that assumes the missing thing inherits
 *    the bug. Nothing here touches the network, so it works for the broken
 *    instance by construction.
 *
 * `readAgentName` / `readWorkspaceId` are the SAME readers the Stop hook uses,
 * imported rather than restated, so this report cannot come to a different
 * verdict from the hook it is reporting on.
 */
import { type EnvLike, readAgentName, readWorkspaceId } from './agent-notes.ts';

/** One setting the note hooks need, and what its absence costs. */
interface Requirement {
  /** Current spelling — the one to set. */
  name: string;
  /** Pre-rename spelling, still honoured by the readers. */
  legacy: string;
  read: (env: EnvLike) => string | undefined;
  /** What stops working, in the agent's own terms. */
  consequence: string;
}

const REQUIREMENTS: readonly Requirement[] = [
  {
    name: 'CW_WORKSPACE_ID',
    legacy: 'FEEDBACK_WORKSPACE_ID',
    read: readWorkspaceId,
    consequence: 'this session has no board, so nothing it posts can be filed against one',
  },
  {
    name: 'CW_AGENT_NAME',
    legacy: 'FEEDBACK_AGENT_NAME',
    read: readAgentName,
    consequence: 'nothing it posts can be attributed to an agent',
  },
];

export interface SessionStartReport {
  /** Current spellings of the settings that are absent, in `REQUIREMENTS`
   *  order. Empty is not representable: a report with nothing missing is
   *  `undefined` instead. */
  missing: readonly string[];
  /** The text handed to the agent. */
  text: string;
}

/**
 * The report for this environment, or `undefined` when there is nothing to say.
 *
 * Silence when healthy is deliberate (calm by default): the only line this ever
 * writes is one naming something that is actually broken, so the presence of a
 * line is itself the signal.
 */
export function sessionStartReport(env: EnvLike): SessionStartReport | undefined {
  const absent = REQUIREMENTS.filter((r) => r.read(env) === undefined);
  if (absent.length === 0) return undefined;
  const named = absent
    .map((r) => `${r.name} (legacy spelling ${r.legacy} is absent too) — ${r.consequence}`)
    .join('; ');
  const text =
    `[claude-workspaces] This session's end-of-turn notes are going NOWHERE. ` +
    `The plugin's Stop hook is installed and runs, but it is missing: ${named}. ` +
    'It therefore exits 0 posting nothing on every turn, which looks exactly like a ' +
    'session that had nothing to say — so this gap is invisible from the outside and ' +
    'nothing will report it again. ' +
    `Fix: relaunch this session with ${absent.map((r) => r.name).join(' and ')} set in its ` +
    'environment (the board id is the `w-…` in its URL). Setting it mid-session does not ' +
    'help — the hook reads the environment it was launched with. Until then, say so when ' +
    'you report: your turns are not in the record.';
  return { missing: absent.map((r) => r.name), text };
}

/**
 * The stdout envelope that puts `text` into the session's context.
 *
 * `hookSpecificOutput.additionalContext` is the one SessionStart field that
 * reaches the model rather than the transcript. Kept here beside the report so
 * the wire shape is unit-testable without spawning a process — and so there is
 * exactly one spelling of these key names in the plugin.
 */
export function sessionStartOutput(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  });
}
