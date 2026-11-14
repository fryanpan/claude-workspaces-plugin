/**
 * The component tools. Each is one REST call to the server's
 * `routes/doc-component-agent.ts`, which validates everything; this arm only
 * addresses the call and signs the writes with the session's author.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { boardPathOf } from '../board-path.ts';

export interface ComponentToolContext {
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  ok: (data: unknown) => CallToolResult;
  err: (message: string) => CallToolResult;
  suggestionAuthor: () => { id: string; name: string; color: string };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export async function handleComponentTool(
  name: string,
  a: Record<string, unknown>,
  ctx: ComponentToolContext,
): Promise<CallToolResult | undefined> {
  const doc = () => {
    const docId = str(a.docId);
    if (docId === '') throw new Error(`${name} needs a docId`);
    return `${boardPathOf(name, a)}/docs/${encodeURIComponent(docId)}`;
  };
  const state = () => {
    const id = str(a.componentId);
    if (id === '') throw new Error(`${name} needs a componentId: the tag's id prop`);
    return `${doc()}/agent-components/${encodeURIComponent(id)}/state`;
  };
  switch (name) {
    case 'list_components':
      return ctx.ok(await ctx.http('GET', `${doc()}/agent-components`));
    case 'get_component_state': {
      const path = str(a.path);
      const q = path ? `?path=${encodeURIComponent(path)}` : '';
      return ctx.ok(await ctx.http('GET', `${state()}${q}`));
    }
    case 'set_component_state':
      return ctx.ok(
        await ctx.http('POST', state(), { ops: a.ops, author: ctx.suggestionAuthor() }),
      );
    case 'place_component':
      return ctx.ok(
        await ctx.http('POST', `${doc()}/agent-components/place`, {
          importPath: a.importPath,
          ...(a.name !== undefined ? { name: a.name } : {}),
          props: a.props,
          ...(a.headingId !== undefined ? { headingId: a.headingId } : {}),
          author: ctx.suggestionAuthor(),
        }),
      );
    case 'request_component_grant':
      return ctx.ok(
        await ctx.http('POST', `${doc()}/component-grants`, {
          folder: a.folder,
          taskId: a.taskId,
          why: a.why,
          author: ctx.suggestionAuthor(),
        }),
      );
    default:
      return undefined;
  }
}
