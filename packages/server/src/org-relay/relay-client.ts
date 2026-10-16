/**
 * The relay's calls to project servers. Three, each an existing board verb,
 * so no route was added for the relay:
 *
 *   GET  /workspaces/<board>/docs/<outbox>/threads           read a seat's outbox
 *   POST /workspaces/<board>/docs/<inbox>/threads            deliver (a subject thread)
 *   POST /workspaces/<board>/docs/<doc>/threads/<t>/comments tell the sender the verdict
 *
 * Every call carries the server's Access service-token pair (when the config
 * gives one) and the relay's bearer for that server. The bearer is opaque
 * here; the server's own door decides what it opens (the board-scoped agent
 * token admits exactly the routes a member of its one board may reach).
 */
import type { RelayServer } from './relay-config.ts';

export type RelayFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Who the relay's own writes are attributed to on every board. */
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
}

const REQUEST_TIMEOUT_MS = 10_000;
/** The most bytes one outbox read may be. */
const MAX_OUTBOX_BYTES = 2_000_000;

function headers(server: RelayServer, json: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${server.bearer}`,
    ...(server.serviceToken
      ? {
          'cf-access-client-id': server.serviceToken.clientId,
          'cf-access-client-secret': server.serviceToken.clientSecret,
        }
      : {}),
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

function docPath(board: string, doc: string): string {
  return `/workspaces/${encodeURIComponent(board)}/docs/${encodeURIComponent(doc)}`;
}

async function call(
  fetchFn: RelayFetch,
  server: RelayServer,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<Response> {
  return fetchFn(`${server.baseUrl}${path}`, {
    method: init.method,
    headers: headers(server, init.body !== undefined),
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
    res = await call(fetchFn, server, `${docPath(board, doc)}/threads?status=open`, {
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
    out.push({
      id: r.id,
      status: typeof r.status === 'string' ? r.status : '',
      createdById: createdBy.id,
      comments,
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
    const res = await call(fetchFn, server, `${docPath(board, doc)}/threads`, {
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
      `${docPath(board, doc)}/threads/${encodeURIComponent(threadId)}/comments`,
      { method: 'POST', body: { author: RELAY_AUTHOR, text } },
    );
    return res.ok;
  } catch {
    return false;
  }
}
