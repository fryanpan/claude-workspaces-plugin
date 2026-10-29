/**
 * The two access writes that widen who is in — letting an address into a
 * board, and approving an agent's access card — sent so that a sign-in older
 * than ten minutes asks "Confirm it's you" (`../fresh-signin-client.ts`).
 * Shared by the board's Settings and the access page, each through its own
 * `send`. Taking someone out and rejecting a card are never asked, and go
 * straight through that `send`.
 */
import {
  type CountedRequest,
  type FreshSignInDeps,
  resumeHeld,
  sendCounted,
} from '../fresh-signin-client.ts';

/** What the access writes read back: the page's `send` reply, filled in. */
export interface AccessReply {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
}

/** A page's own JSON writer. */
export type AccessSend = (
  path: string,
  method: string,
  body: unknown,
) => Promise<{ ok: boolean; status?: number; data?: Record<string, unknown> | null }>;

export function letInRequest(workspaceId: string, match: string): CountedRequest {
  return {
    method: 'POST',
    url: `/workspaces/${encodeURIComponent(workspaceId)}/audience`,
    body: { add: [match] },
    verb: 'Let in',
    gerund: 'Letting someone in',
    noun: 'access change',
    name: match,
  };
}

/** Approving the card at `path`, which echoes the change it shows. */
export function approveRequest(path: string, access: unknown, line: string): CountedRequest {
  return {
    method: 'POST',
    url: path,
    body: { decision: 'approve', access },
    verb: 'Approve',
    gerund: 'Approving an access change',
    noun: 'approval',
    name: line,
  };
}

const NO_BODY = new Set([204, 205, 304]);

/** `sendCounted` speaks `fetch`; the pages speak `send`. */
function through(send: AccessSend): NonNullable<FreshSignInDeps['fetchImpl']> {
  return async (url, init) => {
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const r = await send(url, init.method ?? 'POST', body);
    const status = r.status ?? (r.ok ? 200 : 500);
    return new Response(NO_BODY.has(status) ? null : JSON.stringify(r.data ?? null), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function replyOf(res: Response): Promise<AccessReply> {
  const data: unknown = await res.json().catch(() => null);
  return {
    ok: res.ok,
    status: res.status,
    data: data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null,
  };
}

/** Send one; null when the person cancelled the "Confirm it's you" ask. */
export async function sendAccessWrite(
  req: CountedRequest,
  send: AccessSend,
  toast: (message: string) => void,
): Promise<AccessReply | null> {
  const res = await sendCounted(req, { toast, fetchImpl: through(send) });
  return res ? replyOf(res) : null;
}

/**
 * Back from "Sign in again": offer the write this page held, and say how it
 * went. True when it was sent, so the page re-reads.
 */
export async function resumeAccessWrite(
  send: AccessSend,
  toast: (message: string) => void,
): Promise<boolean> {
  const held = await resumeHeld({ toast, fetchImpl: through(send) });
  if (!held) return false;
  const { request } = held;
  const reply = await replyOf(held.response);
  const said = reply.data?.message;
  if (!reply.ok) toast(typeof said === 'string' ? said : `Could not finish: ${request.name}`);
  else if (request.verb === 'Approve') toast(`Approved. ${request.name}`);
  else toast(`${request.name} can now sign in`);
  return true;
}
