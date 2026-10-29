/**
 * `POST /workspaces/{id}/agents/{name}/prompts` — the plugin's
 * UserPromptSubmit hook says a session got a prompt, and whether a person
 * typed it. The body is `{ typed, sessionId?, cwd?, at?, text?, remote? }`;
 * `text` is a typed prompt as the hook reduced it (`note-redact.ts`), and an
 * injected one carries none. `remote: true` says the session runs under
 * Remote Control, which the coverage report counts apart from a terminal
 * (`coach/coverage.ts`).
 *
 * Nothing is stored. The mark goes to the coach (`coach/session-minutes.ts`),
 * which counts the owner's Claude Code time from his typed prompts and says
 * each in a few words in its digest (`coach/summary.ts`); only the repo's
 * folder name is taken from `cwd`. Same posture as the notes route
 * beside it: under a board scope, refused to share visitors, and a shared
 * agent name is refused.
 */
import { AT_FUTURE_MS, AT_PAST_MS } from '../agent-notes.ts';
import { SHARED_IDENTITY_ERROR, SHARED_IDENTITY_MESSAGE } from '../agent-watches.ts';
import { isSharedAgentName } from '../chat-audit.ts';
import { matchRest } from '../middleware/workspace-scope.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

const SESSION_ID_MAX = 200;
/** What the hook sends at most; the coach keeps less. */
const TEXT_MAX = 4_000;

export async function handlePromptMarkRoute(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const { j, safeJson } = ctx;
  const match = matchRest(rq.scope, /^agents\/([^/]+)\/prompts$/);
  const boardId = rq.scope?.workspaceId;
  if (!match || boardId === undefined) return undefined;
  // The board's own lead is the session the mark is about (lead-scope.ts).
  if (rq.visitor && rq.leadBoard !== boardId)
    return j(403, { error: 'not available to share visitors' });
  if (rq.req.method !== 'POST') return j(405, { error: 'method not allowed' });
  const agent = decodeURIComponent(match[1] ?? '').trim();
  if (agent.length === 0 || agent.length > 200) return j(400, { error: 'bad agent' });
  if (isSharedAgentName(agent)) {
    return j(400, { error: SHARED_IDENTITY_ERROR, message: SHARED_IDENTITY_MESSAGE });
  }
  const raw = await safeJson(rq.req);
  if (raw === null) return j(400, { error: 'bad-body' });
  if (typeof raw.typed !== 'boolean') return j(400, { error: 'bad-typed' });
  const { sessionId } = raw;
  if (
    sessionId !== undefined &&
    (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > SESSION_ID_MAX)
  ) {
    return j(400, { error: 'bad-session' });
  }
  const { text } = raw;
  if (text !== undefined && (typeof text !== 'string' || text.length > TEXT_MAX)) {
    return j(400, { error: 'bad-text' });
  }
  if (raw.remote !== undefined && typeof raw.remote !== 'boolean') {
    return j(400, { error: 'bad-remote' });
  }
  // The hook's clock inside the window the notes route trusts, else ours.
  const now = Date.now();
  const at =
    typeof raw.at === 'number' && raw.at >= now - AT_PAST_MS && raw.at <= now + AT_FUTURE_MS
      ? raw.at
      : now;
  try {
    ctx.coachSessionPrompt(
      boardId,
      {
        agent,
        typed: raw.typed,
        at,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(text !== undefined && raw.typed ? { text } : {}),
        ...(raw.remote === true ? { remote: true } : {}),
      },
      raw.cwd,
    );
  } catch (err) {
    console.warn(`[coach] prompt mark not counted: ${String(err)}`);
  }
  return j(202, { ok: true });
}
