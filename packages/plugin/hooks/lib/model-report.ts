/**
 * Tells the board what a lead's session runs on, for the model chip in the
 * lead chat, and lets a `/model` the board typed through.
 *
 * No single event carries both values. SessionStart may carry `model`, a
 * switch carries `to_model`, and effort arrives on Stop as `effort.level`, so
 * each posts what it has. SessionStart comes before the session is marked as
 * the lead and always posts; the server drops a report from anybody else.
 * Later events post only for a marked lead, so a builder's turn makes no call.
 *
 * `PreModelSwitch` is what makes the switch happen with no question. While the
 * prompt cache is warm, `/model` stops and asks the person at the terminal to
 * confirm, which on a phone is a person who is not there. The answer is allow
 * for a marked lead and only for a `/model <name>` command, the shape the board
 * types. It also skips that one question when the owner types it in that
 * terminal. Anything else gets no answer, so Claude Code asks as usual.
 */
import type { SecretReader } from './access-headers.ts';
import {
  type EnvLike,
  POST_TIMEOUT_MS,
  boardOf,
  readAgentName,
  resolveTransport,
} from './agent-notes.ts';
import { isMarkedLead, mirrorDir } from './session-mirror.ts';

const MODEL_ID = /^claude-[a-z0-9-]{1,60}(\[1m\])?$/;
const EFFORT = /^[a-z]{1,10}$/;

export interface ModelBody {
  kind: 'model';
  model?: string;
  effort?: string;
  started?: boolean;
}

const modelIn = (v: unknown): string | undefined =>
  typeof v === 'string' && MODEL_ID.test(v) ? v : undefined;

/** The report one hook payload makes, or undefined for none. */
export function decideModelReport(payload: unknown, dir = mirrorDir()): ModelBody | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.agent_id === 'string' && p.agent_id !== '') return undefined;
  const event = p.hook_event_name;
  if (event === 'SessionStart') {
    const model = modelIn(p.model);
    return { kind: 'model', started: true, ...(model ? { model } : {}) };
  }
  if (!isMarkedLead(p.session_id, dir)) return undefined;
  if (event === 'PostModelSwitch') {
    const model = modelIn(p.to_model);
    return model ? { kind: 'model', model } : undefined;
  }
  if (event === 'Stop') {
    const level = (p.effort as { level?: unknown } | null | undefined)?.level;
    return typeof level === 'string' && EFFORT.test(level)
      ? { kind: 'model', effort: level }
      : undefined;
  }
  return undefined;
}

/** The stdout of `PreModelSwitch`, or '' for no answer. */
export function allowSwitch(payload: unknown, dir = mirrorDir()): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const p = payload as Record<string, unknown>;
  if (p.hook_event_name !== 'PreModelSwitch' || p.source !== 'command') return '';
  if (typeof p.agent_id === 'string' && p.agent_id !== '') return '';
  if (!isMarkedLead(p.session_id, dir)) return '';
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'allow' },
  });
}

export interface ModelHookDeps {
  env: EnvLike;
  fetch?: typeof fetch;
  discoveryPort?: () => number | undefined;
  joinedBoard?: boolean;
  readSecret?: SecretReader;
  mirrorDir?: string;
}

/** Post the report. Never throws: a report the board misses costs a stale chip. */
export async function runModelReport(stdin: string, deps: ModelHookDeps): Promise<boolean> {
  try {
    const body = decideModelReport(JSON.parse(stdin), deps.mirrorDir ?? mirrorDir(deps.env));
    if (!body) return false;
    const agent = readAgentName(deps.env);
    if (!agent) return false;
    const transport = resolveTransport(
      deps.env,
      deps.discoveryPort,
      deps.fetch ?? fetch,
      deps.readSecret,
    );
    if (!transport) return false;
    const workspaceId = await boardOf(deps.env, transport, agent, deps.joinedBoard);
    if (!workspaceId) return false;
    const path = `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agent)}/mirror`;
    const res = await transport.fetch(`${transport.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
