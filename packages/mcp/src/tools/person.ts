/**
 * The person verbs: `watch_person`, `show_person` and `confirm_person`.
 *
 * `watch_person` asks the server to tell this session where the board
 * owner's attended tab lands (`person.landed` lines, `person-line.ts`) and
 * answers with where it is now. `show_person` takes that one tab to a place;
 * a tab in the background or on another device stays where it is. Both
 * routes are `routes/workspace-point.ts`, and both need this session's agent
 * token (`agent-token.ts`).
 *
 * `placeOf` is the place `point_at` names too, so the two verbs accept the
 * same fields and the server checks them the same way (`buildSpot`).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentAuthor } from '../author.ts';

export interface PersonToolContext {
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  ok: (data: unknown) => CallToolResult;
  err: (message: string) => CallToolResult;
  AUTHOR: AgentAuthor;
}

/** The place fields a pointer or a show names, trimmed; absent ones dropped. */
export function placeOf(a: Record<string, unknown>): Record<string, unknown> {
  const place: Record<string, unknown> = {};
  for (const k of ['path', 'docId', 'taskId', 'goalId', 'threadId', 'blockId', 'quote'] as const) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) place[k] = v.trim();
  }
  for (const k of ['scroll', 'x', 'y'] as const) {
    if (typeof a[k] === 'number') place[k] = a[k];
  }
  return place;
}

/** A refusal the server answered with a status in `codes`, as `{error}`; else null. */
export function refusalOf(e: unknown, codes: readonly number[]): { error: string } | null {
  const m = String(e).match(/→ (\d{3}): (.*)$/s);
  if (!m || !codes.includes(Number(m[1]))) return null;
  try {
    const error = (JSON.parse(m[2] ?? '') as { error?: unknown }).error;
    if (typeof error === 'string') return { error };
  } catch {}
  return { error: `refused (${m[1]})` };
}

export async function handlePersonTool(
  name: string,
  a: Record<string, unknown>,
  ctx: PersonToolContext,
): Promise<CallToolResult | undefined> {
  if (name === 'confirm_person') return confirmPerson(a, ctx);
  if (name !== 'watch_person' && name !== 'show_person') return undefined;
  const workspaceId = typeof a.workspaceId === 'string' ? a.workspaceId : '';
  if (!workspaceId) return ctx.err('workspaceId is required');
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/person`;
  const who = { agentId: ctx.AUTHOR.id, agentName: ctx.AUTHOR.name };
  if (name === 'watch_person') {
    const on = a.on !== false;
    try {
      const res = (await ctx.http('POST', `${base}/watch`, { ...who, on })) as {
        landing?: unknown;
      };
      return ctx.ok({ watching: on, landing: res.landing ?? null });
    } catch (e) {
      const refused = refusalOf(e, [400, 403, 404]);
      if (!refused) throw e;
      return ctx.ok({ watching: false, ...refused });
    }
  }
  try {
    const res = (await ctx.http('POST', `${base}/show`, { ...who, ...placeOf(a) })) as {
      spot?: unknown;
    };
    return ctx.ok({ shown: true, spot: res.spot });
  } catch (e) {
    const refused = refusalOf(e, [400, 403, 404, 409]);
    if (!refused) throw e;
    return ctx.ok({
      shown: false,
      ...refused,
      ...(refused.error === 'not-here'
        ? { note: 'Nobody is looking at this board now. Post the link on the task instead.' }
        : {}),
    });
  }
}

/**
 * `confirm_person`: this agent's half of its person link
 * (`POST /api/agents/<id>/person`, `person-agent-link.ts` on the server).
 */
async function confirmPerson(
  a: Record<string, unknown>,
  ctx: PersonToolContext,
): Promise<CallToolResult> {
  if (a.email !== null && (typeof a.email !== 'string' || !a.email.trim())) {
    return ctx.err('email is required (or null to clear)');
  }
  const body = a.email === null ? { personId: null } : { email: String(a.email).trim() };
  try {
    const res = (await ctx.http(
      'POST',
      `/api/agents/${encodeURIComponent(ctx.AUTHOR.id)}/person`,
      body,
    )) as { state?: unknown };
    return ctx.ok({ ok: true, state: res.state ?? null });
  } catch (e) {
    const refused = refusalOf(e, [400, 401, 403]);
    if (!refused) throw e;
    return ctx.ok({ ok: false, ...refused });
  }
}
