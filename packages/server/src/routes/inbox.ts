import { isValidAgentId } from '../agent-watches.ts';
/**
 * ── Incoming Messages: the reader's post and Bryan's taps ──
 *
 *   POST /inbox/rows               a poster's pass: up to 40 rows, upserted
 *                                  by source thread id. The ONLY write path
 *                                  for message content. An optional `run`
 *                                  closes the poster's own scheduled run
 *                                  (inbox/run-close.ts); an optional
 *                                  `dismiss` takes up to 40 rows off the
 *                                  list as handled elsewhere.
 *   GET  /inbox/rows/:id/body      the message text, for an opened line,
 *                                  and which reply it offers
 *   POST /inbox/rows/:id/state     Bryan's tap: snooze, dismiss, remove,
 *                                  mark answered, reopen, undo
 *   POST /inbox/rows/:id/reply     Bryan's Send: `{ text, nonce }`, sent on
 *                                  the row's own thread (inbox/reply.ts)
 *
 * Owner-level, not under a board: messages belong to Bryan, so nothing here
 * is on a share or member allowlist and a visitor is refused before anything
 * is read.
 *
 * TWO GATES, AND THEY NEVER OVERLAP:
 *
 *  - The post is for the posters the inbox config names (the reader and
 *    `posterAgentIds`), each proved the way an agent's own feed is
 *    (`authorizeAgentCaller`: on this machine, not through the edge, not
 *    from a page) AND with its token,
 *    always — not only once `CW_REQUIRE_AGENT_TOKEN` is on. A token is
 *    minted only to the process of a session launched as that agent, so a
 *    second session that merely names a poster's id is refused. A poster's
 *    one state move is the dismiss, by thread id, with the one reason
 *    `handled-elsewhere`; it is a history entry Bryan can undo.
 *  - The read and the taps are for Bryan: a person proof (the Access email
 *    or the session cookie) that resolves to the owner, from the front
 *    page's own origin — the grant door's gate (`task-grants.ts`). An agent
 *    on this machine passes trusted-local and still fails here, so no agent
 *    can read a message, move a row or send a reply, the reader included.
 *    The reply's destination comes from the stored row, never the request.
 *
 * No event is emitted for any row. A row reaches a page when the page
 * loads, and never reaches an agent's stream, `next_tasks`, the brief or
 * the activity feed. A run close is an ordinary task transition and emits
 * its ordinary event, with counts only. Logs name counts and ids, never a
 * word of a row.
 */
import type { AgentCallerVerdict } from '../auth/agent-token.ts';
import type { InboxBodies } from '../inbox/bodies.ts';
import { type InboxConfig, hasInboxPoster, isInboxPoster } from '../inbox/config.ts';
import type { InboxReplies } from '../inbox/reply.ts';
import { type RunCloseStore, closeInboxRun } from '../inbox/run-close.ts';
import type { InboxStore, OwnerAction } from '../inbox/store.ts';
import {
  AGENT_DISMISS_REASON,
  DISMISS_REASONS,
  type DismissReason,
  MAX_ROWS_PER_POST,
} from '../inbox/types.ts';
import { DEDUPE_KEY, type ValidateContext, validateRow } from '../inbox/validate.ts';
import type { InboxPostBody } from './inbox-contract.ts';
import { sent } from './route-contract.ts';

export interface InboxRoutesContext {
  store: InboxStore;
  bodies: InboxBodies;
  replies: InboxReplies;
  config: () => InboxConfig;
  goalIsLive: ValidateContext['goalIsLive'];
  /** The board store a `run` is closed through, and the reader's name. */
  runs: RunCloseStore;
  agentName: (agentId: string) => string;
  /** A refusal when the caller is not a process on this machine (through
   *  the edge, from another host, or a page); checked before the body. */
  refuseNonLocal: (req: Request) => Extract<AgentCallerVerdict, { ok: false }> | null;
  /** Whether this request speaks for `agentId`, with its token required. */
  authorizeAgent: (req: Request, agentId: string) => AgentCallerVerdict;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface InboxRouteRequest {
  req: Request;
  pathname: string;
  visitor: unknown;
  /** True when a person proof on this request resolves to the owner. */
  ownerProven: () => boolean;
  /** This server's own origin, as the request reached it. */
  requestOrigin: () => string | undefined;
}

/** The largest post read: forty full rows with room to spare. */
const MAX_POST_BYTES = 1_000_000;
/** A reply's 4000 code points, each up to four bytes, JSON-escaped, and room over. */
const MAX_REPLY_BYTES = 64_000;
const PASS_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const POST_KEYS = new Set<string>(['agentId', 'pass', 'rows', 'run', 'dismiss'] satisfies Array<
  keyof InboxPostBody
>);
const DISMISS_KEYS = new Set(['dedupeKey', 'reason']);
const ROW_PATH = /^\/inbox\/rows\/(ib-[A-Za-z0-9]{12})\/(body|state|reply)$/;

/** A dismiss entry's thread id, or why it is refused. Only the one reason
 *  is accepted, so a poster cannot file a row under spam or not-needed. */
function parseDismiss(raw: unknown): { key: string } | { reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'not an object' };
  const e = raw as Record<string, unknown>;
  if (Object.keys(e).some((k) => !DISMISS_KEYS.has(k))) return { reason: 'unknown field' };
  if (e.reason !== AGENT_DISMISS_REASON)
    return { reason: `reason must be ${AGENT_DISMISS_REASON}` };
  if (typeof e.dedupeKey !== 'string' || !DEDUPE_KEY.test(e.dedupeKey)) {
    return { reason: 'dedupeKey' };
  }
  return { key: e.dedupeKey };
}

/** Bryan's own front page, and nobody else's: the grant door's three checks. */
function refuseNonOwner(ctx: InboxRoutesContext, rq: InboxRouteRequest): Response | null {
  const { j } = ctx;
  const { req } = rq;
  if (rq.visitor) return j(403, { error: 'not available to share visitors' });
  if (!rq.ownerProven()) {
    return j(403, {
      error: 'owner-proof-required',
      message: 'Only the owner, signed in, can read or move an incoming message.',
    });
  }
  const origin = req.headers.get('origin');
  const own = rq.requestOrigin();
  const sameSite = req.headers.get('sec-fetch-site') === 'same-origin';
  // A GET from the page's own script sends no Origin; a POST always does.
  const originOk = req.method === 'GET' ? origin === null || origin === own : origin === own;
  if (!sameSite || own === undefined || !originOk) {
    return j(403, { error: 'same-origin-only', message: 'Use the front page itself.' });
  }
  return null;
}

async function handlePost(ctx: InboxRoutesContext, rq: InboxRouteRequest): Promise<Response> {
  const { j, store, bodies } = ctx;
  const { req } = rq;
  if (rq.visitor) return j(403, { error: 'not available to share visitors' });
  const notLocal = ctx.refuseNonLocal(req);
  if (notLocal) return j(notLocal.status, notLocal.body);
  const length = Number(req.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length > MAX_POST_BYTES) {
    return j(413, { error: 'too-large' });
  }
  const body = sent<InboxPostBody>(await ctx.safeJson(req));
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return j(400, { error: 'body must be a JSON object' });
  }
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  if (!isValidAgentId(agentId)) return j(400, { error: 'agentId required' });
  const allowed = ctx.authorizeAgent(req, agentId);
  if (!allowed.ok) return j(allowed.status, allowed.body);
  const config = ctx.config();
  if (!hasInboxPoster(config)) {
    return j(503, { error: 'inbox-reader-unset', message: 'No inbox reader is configured.' });
  }
  // The code predates the second poster; callers match on it, so it stays.
  if (!isInboxPoster(config, agentId)) {
    return j(403, {
      error: 'not-the-inbox-reader',
      message: 'Only an agent the inbox config lists posts rows.',
    });
  }
  if (Object.keys(body).some((k) => !POST_KEYS.has(k))) return j(400, { error: 'unknown field' });
  const pass = body.pass;
  if (typeof pass !== 'string' || !PASS_ID.test(pass)) return j(400, { error: 'pass' });
  const rows = body.rows;
  const dismiss = body.dismiss;
  if (
    dismiss !== undefined &&
    (!Array.isArray(dismiss) || dismiss.length < 1 || dismiss.length > MAX_ROWS_PER_POST)
  ) {
    return j(400, { error: `dismiss must hold 1 to ${MAX_ROWS_PER_POST} entries` });
  }
  // A pass with nothing new is still a pass, so it may close its run, or
  // dismiss rows, with none. Otherwise an empty post says nothing and stays
  // refused.
  const hasRun = body.run !== undefined;
  const min = hasRun || dismiss !== undefined ? 0 : 1;
  if (!Array.isArray(rows) || rows.length < min || rows.length > MAX_ROWS_PER_POST) {
    return j(400, { error: `rows must hold ${min} to ${MAX_ROWS_PER_POST} rows` });
  }

  const now = (ctx.now ?? Date.now)();
  const vctx: ValidateContext = { config, now, goalIsLive: ctx.goalIsLive };
  const rejected: Array<{ index: number; reason: string }> = [];
  const accepted: Array<{
    index: number;
    row: Parameters<InboxStore['post']>[0][number];
    body: string;
  }> = [];
  const seen = new Set<string>();
  for (const [index, raw] of rows.entries()) {
    const v = validateRow(raw, vctx);
    if (!v.ok) {
      rejected.push({ index, reason: v.reason });
      continue;
    }
    if (seen.has(v.row.dedupeKey)) {
      rejected.push({ index, reason: 'dedupeKey repeated in this pass' });
      continue;
    }
    seen.add(v.row.dedupeKey);
    accepted.push({ index, row: v.row, body: v.body });
  }
  const log = ctx.log ?? ((l: string) => console.log(l));
  const posted = store.post(
    accepted.map((a) => a.row),
    pass,
    agentId === config.readerAgentId,
  );
  if (!posted.ok) {
    log(`[inbox] pass ${pass} refused: over the open-row cap`);
    return j(409, { error: posted.error, message: 'Too many open rows; nothing was stored.' });
  }
  bodies.putAll(posted.ids.map((id, i) => [id, accepted[i]?.body ?? ''] as const));
  log(`[inbox] pass ${pass}: ${accepted.length} accepted, ${rejected.length} rejected`);
  const dismissed = Array.isArray(dismiss) ? dismissRows(ctx, dismiss, seen, agentId) : undefined;
  if (dismissed) {
    const n = dismissed.filter((d) => d.result === 'dismissed').length;
    log(`[inbox] pass ${pass}: ${n} of ${dismissed.length} dismissed by ${agentId}`);
  }
  // After the rows are stored, and never instead of them: a refused close
  // leaves the pass's rows in place and says why in `run`.
  const run = hasRun
    ? closeInboxRun(
        ctx.runs,
        body.run,
        { id: agentId, name: ctx.agentName(agentId) },
        { pass, accepted: accepted.length, rejected: rejected.length },
      )
    : undefined;
  if (run) log(`[inbox] pass ${pass} run: ${run.closed ? `closed ${run.taskId}` : run.error}`);
  return j(200, {
    ok: true,
    accepted: accepted.length,
    created: posted.created,
    updated: posted.updated,
    rejected,
    ...(dismissed ? { dismissed } : {}),
    ...(run ? { run } : {}),
  });
}

/** Each dismiss entry's result by index. A thread this same pass posted is
 *  refused: a post and a dismiss of one row in one call contradict. */
function dismissRows(
  ctx: InboxRoutesContext,
  entries: readonly unknown[],
  postedKeys: ReadonlySet<string>,
  agentId: string,
): Array<{ index: number; result: string }> {
  const results: Array<{ index: number; result: string }> = [];
  const keys: string[] = [];
  const slots: number[] = [];
  for (const [index, raw] of entries.entries()) {
    const p = parseDismiss(raw);
    if ('reason' in p) results.push({ index, result: p.reason });
    else if (postedKeys.has(p.key)) results.push({ index, result: 'posted in this pass' });
    else if (keys.includes(p.key)) results.push({ index, result: 'dedupeKey repeated' });
    else {
      keys.push(p.key);
      slots.push(results.length);
      results.push({ index, result: '' });
    }
  }
  for (const [i, outcome] of ctx.store.dismissByAgent(keys, agentId).entries()) {
    const slot = results[slots[i] ?? -1];
    if (slot) slot.result = outcome;
  }
  return results;
}

function parseAction(body: Record<string, unknown> | null): OwnerAction | null {
  switch (body?.action) {
    case 'snooze':
      return typeof body.until === 'number' ? { kind: 'snooze', until: body.until } : null;
    case 'dismiss': {
      const reason = body.reason;
      return typeof reason === 'string' && (DISMISS_REASONS as readonly string[]).includes(reason)
        ? { kind: 'dismiss', reason: reason as DismissReason }
        : null;
    }
    case 'remove':
      return { kind: 'remove' };
    case 'answer':
      return { kind: 'answer' };
    case 'reopen':
      return { kind: 'reopen' };
    case 'undo':
      return { kind: 'undo' };
    default:
      return null;
  }
}

export async function handleInboxRoutes(
  ctx: InboxRoutesContext,
  rq: InboxRouteRequest,
): Promise<Response | undefined> {
  const { pathname, req } = rq;
  const { j } = ctx;
  if (pathname === '/inbox/rows') {
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
    return handlePost(ctx, rq);
  }
  if (!pathname.startsWith('/inbox/')) return undefined;
  const m = pathname.match(ROW_PATH);
  if (!m) return j(404, { error: 'not-found' });
  const id = m[1] ?? '';
  const verb = m[2];
  if (verb === 'body' ? req.method !== 'GET' : req.method !== 'POST') {
    return j(405, { error: 'method not allowed' });
  }
  const denied = refuseNonOwner(ctx, rq);
  if (denied) return denied;
  const row = ctx.store.get(id);
  if (!row) return j(404, { error: 'not-found' });
  if (verb === 'body') {
    const text = ctx.bodies.get(id) ?? '';
    const reply = ctx.replies.kindFor(row);
    return new Response(JSON.stringify({ id, body: text, link: row.link, reply }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  if (verb === 'reply') {
    const length = Number(req.headers.get('content-length') ?? '0');
    if (!Number.isFinite(length) || length > MAX_REPLY_BYTES) return j(413, { error: 'too-large' });
    const res = await ctx.replies.reply(id, await ctx.safeJson(req));
    return j(res.status, res.body);
  }
  const action = parseAction(await ctx.safeJson(req));
  if (!action)
    return j(400, { error: 'action must be snooze, dismiss, remove, answer, reopen or undo' });
  const res = ctx.store.act(id, action);
  if (!res.ok) return j(res.status, { error: res.error });
  const r = res.row;
  return j(200, {
    id: r.id,
    state: r.state,
    ...(r.snoozedUntil !== undefined ? { snoozedUntil: r.snoozedUntil } : {}),
  });
}
