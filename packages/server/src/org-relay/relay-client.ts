/**
 * The relay's calls to project servers. Three, each an existing board verb,
 * so no route was added for the relay:
 *
 *   GET  /workspaces/<board>/docs/<outbox>/threads           read a seat's outbox
 *   POST /workspaces/<board>/docs/<inbox>/threads            deliver (a subject thread)
 *   POST /workspaces/<board>/docs/<doc>/threads/<t>/comments tell the sender the verdict
 *
 * Every call carries the server's Access service-token pair (when the config
 * gives one) and the relay's board-scoped agent token for the board it names.
 * The token is opaque here; the server's own door decides what it opens (an
 * `at2` admits exactly the routes a member of its one board may reach) and
 * attributes every write to the token's agent, whatever author the body
 * names.
 */
import type { RelayServer } from './relay-config.ts';

export type RelayFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The author the relay's writes name in their body. Behind an `at2` the
 * server ignores it and records the token's agent; it is what a co-located
 * server reached from loopback without a token records.
 */
export const RELAY_AUTHOR = { id: 'agent-relay', name: 'Relay', kind: 'agent' } as const;

export interface OutboxComment {
  authorId: string;
  text: string;
}

export interface OutboxThread {
  id: string;
  status: string;
  createdById: string;
  comments: OutboxComment[];
  /**
   * The agent and board whose board token opened the thread, as the server
   * recorded it outside the doc (`thread-opener-proofs.ts`), or null. An
   * author id alone is not this: loopback and a writable socket can both
   * write one without a token.
   */
  openerProof: { agentId: string; boardId: string } | null;
}

const REQUEST_TIMEOUT_MS = 10_000;
/** The most bytes one outbox read may be. */
const MAX_OUTBOX_BYTES = 2_000_000;

function headers(server: RelayServer, board: string, json: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${server.bearers.get(board) ?? ''}`,
    ...(server.serviceToken
      ? {
          'cf-access-client-id': server.serviceToken.clientId,
          'cf-access-client-secret': server.serviceToken.clientSecret,
        }
      : {}),
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

function docPathPrefix(board: string): string {
  return `/workspaces/${encodeURIComponent(board)}`;
}

function docPath(doc: string): string {
  return `/docs/${encodeURIComponent(doc)}`;
}

async function call(
  fetchFn: RelayFetch,
  server: RelayServer,
  board: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<Response> {
  return fetchFn(`${server.baseUrl}${docPathPrefix(board)}${path}`, {
    method: init.method,
    headers: headers(server, board, init.body !== undefined),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** A seat's open outbox threads, rebuilt field by field; null on any failure. */
export async function readOutbox(
  fetchFn: RelayFetch,
  server: RelayServer,
  board: string,
  doc: string,
): Promise<OutboxThread[] | null> {
  let res: Response;
  try {
    res = await call(fetchFn, server, board, `${docPath(doc)}/threads?status=open`, {
      method: 'GET',
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const text = await res.text();
  if (text.length > MAX_OUTBOX_BYTES) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = (body as { threads?: unknown })?.threads;
  if (!Array.isArray(raw)) return null;
  const out: OutboxThread[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const createdBy = r.createdBy as { id?: unknown } | undefined;
    if (typeof r.id !== 'string' || typeof createdBy?.id !== 'string') continue;
    if (!Array.isArray(r.comments)) continue;
    const comments: OutboxComment[] = [];
    for (const c of r.comments) {
      const author = (c as { author?: { id?: unknown } })?.author;
      const words = (c as { text?: unknown })?.text;
      if (typeof author?.id === 'string' && typeof words === 'string') {
        comments.push({ authorId: author.id, text: words });
      }
    }
    const proof = r.openerProof as { kind?: unknown; agentId?: unknown; boardId?: unknown } | null;
    out.push({
      id: r.id,
      status: typeof r.status === 'string' ? r.status : '',
      createdById: createdBy.id,
      comments,
      openerProof:
        proof?.kind === 'board-token' &&
        typeof proof.agentId === 'string' &&
        typeof proof.boardId === 'string'
          ? { agentId: proof.agentId, boardId: proof.boardId }
          : null,
    });
  }
  return out;
}

/** Open a subject thread on the recipient's inbox doc. True when it landed. */
export async function deliverToInbox(
  fetchFn: RelayFetch,
  server: RelayServer,
  board: string,
  doc: string,
  text: string,
  requestId: string,
): Promise<boolean> {
  try {
    const res = await call(fetchFn, server, board, `${docPath(doc)}/threads`, {
      method: 'POST',
      // requestId makes a retry after a lost answer land once, not twice.
      body: { author: RELAY_AUTHOR, text, anchor: { kind: 'subject' }, requestId },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Reply on the sender's outbox thread. Best effort: the log is the record. */
export async function replyOnOutbox(
  fetchFn: RelayFetch,
  server: RelayServer,
  board: string,
  doc: string,
  threadId: string,
  text: string,
): Promise<boolean> {
  try {
    const res = await call(
      fetchFn,
      server,
      board,
      `${docPath(doc)}/threads/${encodeURIComponent(threadId)}/comments`,
      { method: 'POST', body: { author: RELAY_AUTHOR, text } },
    );
    return res.ok;
  } catch {
    return false;
  }
}
