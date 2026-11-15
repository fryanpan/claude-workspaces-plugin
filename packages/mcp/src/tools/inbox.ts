/**
 * `post_inbox_rows` — an inbox poster's one verb: a pass of Incoming
 * Messages rows, upserted by source thread id (`POST /inbox/rows`).
 *
 * Only the posters the server's inbox config names (the reader and its
 * `posterAgentIds`) may call it, and only with their own agent token; any
 * other caller is refused by the server, not here.
 * The arguments are forwarded as given — the server checks every field — so
 * this arm adds nothing a hostile caller could lean on.
 *
 * `run` names the scheduled run this pass answers; the server closes it if
 * it is this reader's own open instance. With a run the pass may carry no
 * rows, because a pass that found nothing new is still a pass.
 *
 * `dismiss` takes rows off Bryan's list by thread id, as handled elsewhere;
 * with it the pass may carry no rows either.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentAuthor } from '../author.ts';
import { inboxClient } from '../server-client.ts';

export interface InboxToolContext {
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  ok: (data: unknown) => CallToolResult;
  err: (message: string) => CallToolResult;
  AUTHOR: AgentAuthor;
}

export async function handleInboxTool(
  name: string,
  a: Record<string, unknown>,
  ctx: InboxToolContext,
): Promise<CallToolResult | undefined> {
  switch (name) {
    case 'post_inbox_rows': {
      const { pass, run, dismiss } = a;
      const rows = a.rows ?? (dismiss !== undefined ? [] : undefined);
      if (typeof pass !== 'string' || pass === '') return ctx.err('pass is required');
      if (!Array.isArray(rows)) return ctx.err('rows must be a list');
      if (rows.length === 0 && run === undefined && dismiss === undefined)
        return ctx.err('rows must be a non-empty list unless run or dismiss is given');
      // An absent run or dismiss is undefined, and JSON drops it.
      const res = await inboxClient(ctx.http).inbox.rows.$post({
        json: { agentId: ctx.AUTHOR.id, pass, rows, run, dismiss },
      });
      return ctx.ok(await res.json());
    }
    default:
      return undefined;
  }
}
