/**
 * The whiteboard verbs: `create_whiteboard`, `draw_on_whiteboard`,
 * `get_whiteboard`.
 *
 * Thin by design. The server validates every shape and builds the full
 * Excalidraw elements (`packages/server/src/whiteboard/elements.ts`); this arm
 * only addresses the call and names the agent, so the canvas can label its
 * pointer and the change event can name who drew.
 *
 * `create_whiteboard` watches the new board's doc at once, so the first
 * stroke a person makes reaches the agent without a separate `watch_doc`.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentAuthor } from '../author.ts';
import { boardPathOf } from '../board-path.ts';

export interface WhiteboardToolContext {
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  ok: (data: unknown) => CallToolResult;
  err: (message: string) => CallToolResult;
  AUTHOR: AgentAuthor;
  watchDoc: (docId: string, persist?: boolean) => Promise<boolean>;
}

export async function handleWhiteboardTool(
  name: string,
  a: Record<string, unknown>,
  ctx: WhiteboardToolContext,
): Promise<CallToolResult | undefined> {
  switch (name) {
    case 'create_whiteboard': {
      const title = typeof a.title === 'string' ? a.title : undefined;
      const res = (await ctx.http('POST', `${boardPathOf(name, a)}/whiteboards`, {
        ...(title !== undefined ? { title } : {}),
        author: ctx.AUTHOR,
      })) as { docId?: string; url?: string; meta?: { reviewUrl?: string } };
      if (typeof res?.docId !== 'string') return ctx.err('the server did not return a whiteboard');
      await ctx.watchDoc(res.docId);
      return ctx.ok({ docId: res.docId, url: res.meta?.reviewUrl ?? res.url });
    }
    case 'draw_on_whiteboard': {
      const docId = typeof a.docId === 'string' ? a.docId : '';
      if (docId === '') return ctx.err('docId is required');
      if (!Array.isArray(a.shapes)) return ctx.err('shapes must be a list');
      const res = await ctx.http(
        'POST',
        `${boardPathOf(name, a)}/docs/${encodeURIComponent(docId)}/whiteboard`,
        {
          shapes: a.shapes,
          ...(a.mode !== undefined ? { mode: a.mode } : {}),
          ...(a.point !== undefined ? { point: a.point } : {}),
          author: ctx.AUTHOR,
        },
      );
      return ctx.ok(res);
    }
    case 'get_whiteboard': {
      const docId = typeof a.docId === 'string' ? a.docId : '';
      if (docId === '') return ctx.err('docId is required');
      const res = await ctx.http(
        'GET',
        `${boardPathOf(name, a)}/docs/${encodeURIComponent(docId)}/whiteboard`,
      );
      return ctx.ok(res);
    }
    default:
      return undefined;
  }
}
