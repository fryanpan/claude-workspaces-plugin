#!/usr/bin/env bun
/**
 * Whether the org relay has asked for THIS machine's lead to be restarted.
 * `lead.sh supervise` runs it every 30 seconds and, when it prints
 * `restart`, ends the lead's tmux session; the supervisor then starts the
 * session again with `--continue`, as it does after any end.
 *
 * Team Lead asks by sending `restart-lead` through the relay
 * (`packages/server/src/org-relay/relay-kinds.ts`). The relay refuses it
 * unless this seat's `restartFrom` names the sender, and delivers it onto
 * this lead's inbox doc as one fixed line. This script acts on a thread only
 * when all of these hold:
 *
 *  - the server's opener proof says the relay's own board token, for this
 *    board, opened it (`thread-opener-proofs.ts`). The lead and anything else
 *    on the board's socket can write a thread there too, but never with that
 *    proof, so nobody on the machine can restart the lead through this path;
 *  - its opening comment is exactly the relay's restart line
 *    (`RESTART_HEADER`), naming this lead's own agent id;
 *  - it is not one already handled (`<CW_LEAD_ROOT>/restart-handled.json`)
 *    and is less than ten minutes old, so a request that waited while the
 *    machine was down does not restart a lead that has just started.
 *
 * Every candidate it sees is recorded as handled, acted on or not, and at
 * most one restart is printed per run.
 *
 * Environment: CW_BOARD_SOCKET, CW_WORKSPACE_ID, CW_AGENT_NAME (or
 * CW_LEAD_AGENT_ID), CW_LEAD_ROOT, and the two the relay's install sets:
 * CW_LEAD_INBOX_DOC (this seat's `inboxDoc`) and CW_RELAY_AGENT_ID (the
 * agent the relay's board token names). Without those two it does nothing.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentIdForName } from '../../packages/core/src/identity.ts';
import { RESTART_HEADER } from '../../packages/server/src/org-relay/relay-kinds.ts';

/** A request older than this is recorded and not acted on. */
/** How long one call to the board server may take. */
const FETCH_TIMEOUT_MS = 10_000;

export const RESTART_MAX_AGE_MS = 10 * 60_000;
/** The most handled ids kept; the oldest go first. */
const MAX_HANDLED = 500;

export interface InboxThread {
  id: string;
  comments: Array<{ text: string; ts: number }>;
  openerProof: { agentId: string; boardId: string } | null;
}

export interface RestartContext {
  boardId: string;
  relayAgentId: string;
  ownAgentId: string;
  handled: ReadonlySet<string>;
  now: number;
}

/**
 * The thread to act on, if any, and every candidate to record as handled.
 * Pure, so the rule is tested without a server.
 */
export function pickRestart(
  threads: readonly InboxThread[],
  ctx: RestartContext,
): { act: string | null; seen: string[] } {
  const seen: string[] = [];
  let act: string | null = null;
  for (const t of threads) {
    if (ctx.handled.has(t.id)) continue;
    const proof = t.openerProof;
    if (proof?.agentId !== ctx.relayAgentId || proof.boardId !== ctx.boardId) continue;
    const opener = t.comments[0];
    const m = opener ? RESTART_HEADER.exec(opener.text) : null;
    if (!opener || !m || m[2] !== ctx.ownAgentId) continue;
    seen.push(t.id);
    if (act === null && ctx.now - opener.ts < RESTART_MAX_AGE_MS && opener.ts <= ctx.now + 60_000) {
      act = t.id;
    }
  }
  return { act, seen };
}

/** The thread list as the server answers it, rebuilt field by field. */
export function readInboxThreads(body: unknown): InboxThread[] {
  const raw = (body as { threads?: unknown })?.threads;
  if (!Array.isArray(raw)) return [];
  const out: InboxThread[] = [];
  for (const t of raw) {
    const r = t as Record<string, unknown>;
    if (typeof r?.id !== 'string' || !Array.isArray(r.comments)) continue;
    const comments: InboxThread['comments'] = [];
    for (const c of r.comments as Array<Record<string, unknown>>) {
      if (typeof c?.text === 'string' && typeof c.ts === 'number') {
        comments.push({ text: c.text, ts: c.ts });
      }
    }
    const p = r.openerProof as Record<string, unknown> | null | undefined;
    out.push({
      id: r.id,
      comments,
      openerProof:
        p?.kind === 'board-token' && typeof p.agentId === 'string' && typeof p.boardId === 'string'
          ? { agentId: p.agentId, boardId: p.boardId }
          : null,
    });
  }
  return out;
}

export type BoardFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** One check: `restart` when this lead is to be restarted now, else ''. */
export async function checkOnce(opts: {
  fetch: BoardFetch;
  boardId: string;
  inboxDoc: string;
  relayAgentId: string;
  ownAgentId: string;
  stateFile: string;
  now: number;
}): Promise<string> {
  const handled = readHandled(opts.stateFile);
  const board = encodeURIComponent(opts.boardId);
  const doc = encodeURIComponent(opts.inboxDoc);
  const res = await opts.fetch(`/workspaces/${board}/docs/${doc}/threads?status=open`);
  if (!res.ok) throw new Error(`thread list answered ${res.status}`);
  const { act, seen } = pickRestart(readInboxThreads(await res.json()), {
    boardId: opts.boardId,
    relayAgentId: opts.relayAgentId,
    ownAgentId: opts.ownAgentId,
    handled: new Set(handled),
    now: opts.now,
  });
  if (seen.length === 0) return '';
  // Recorded before anything acts, so a run that dies after this line never
  // restarts the lead twice for one request.
  writeHandled(opts.stateFile, [...handled, ...seen].slice(-MAX_HANDLED));
  if (act === null) return '';
  // Best effort: the reply tells whoever looks at the inbox what happened.
  await opts
    .fetch(`/workspaces/${board}/docs/${doc}/threads/${encodeURIComponent(act)}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `Restarting ${opts.ownAgentId} now.`,
        author: { id: opts.ownAgentId, name: opts.ownAgentId, kind: 'agent' },
      }),
    })
    .catch(() => undefined);
  return 'restart';
}

function readHandled(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeHandled(path: string, ids: string[]): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ids)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

if (import.meta.main) {
  const env = process.env;
  const socket = env.CW_BOARD_SOCKET;
  const boardId = env.CW_WORKSPACE_ID;
  const inboxDoc = env.CW_LEAD_INBOX_DOC;
  const relayAgentId = env.CW_RELAY_AGENT_ID;
  const root = env.CW_LEAD_ROOT;
  const ownAgentId =
    env.CW_LEAD_AGENT_ID || (env.CW_AGENT_NAME ? agentIdForName(env.CW_AGENT_NAME) : '');
  // Not installed: nothing to watch.
  if (!inboxDoc || !relayAgentId) process.exit(0);
  if (!socket || !boardId || !root || !ownAgentId) {
    console.error('[lead-restart] missing CW_BOARD_SOCKET, CW_WORKSPACE_ID, CW_LEAD_ROOT or agent');
    process.exit(2);
  }
  try {
    const out = await checkOnce({
      // Each call is cut off, so a hung board server ends the check rather
      // than holding it; lead.sh bounds the whole run as well.
      fetch: (path, init) =>
        fetch(`http://localhost${path}`, {
          ...init,
          unix: socket,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        } as RequestInit),
      boardId,
      inboxDoc,
      relayAgentId,
      ownAgentId,
      stateFile: join(root, 'restart-handled.json'),
      now: Date.now(),
    });
    if (out) console.log(out);
  } catch (err) {
    console.error(`[lead-restart] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
