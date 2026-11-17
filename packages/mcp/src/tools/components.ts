/**
 * The component tools. Each is one REST call to the server's
 * `routes/doc-component-agent.ts`, which validates everything; this arm only
 * addresses the call and signs the writes with the session's author.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { boardIdOf } from '../board-path.ts';
import { docComponentsClient } from '../server-client.ts';

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
  const api = () => docComponentsClient(ctx.http).workspaces[':ws'].docs[':docId'];
  const doc = () => {
    const docId = str(a.docId);
    if (docId === '') throw new Error(`${name} needs a docId`);
    return { ws: encodeURIComponent(boardIdOf(name, a)), docId: encodeURIComponent(docId) };
  };
  const state = () => {
    const id = str(a.componentId);
    if (id === '') throw new Error(`${name} needs a componentId: the tag's id prop`);
    return { ...doc(), id: encodeURIComponent(id) };
  };
  const stateApi = () => api()['agent-components'][':id'].state;
  switch (name) {
    case 'list_components':
      return ctx.ok(await (await api()['agent-components'].$get({ param: doc() })).json());
    case 'get_component_state': {
      const path = str(a.path);
      return ctx.ok(
        await (await stateApi().$get({ param: state(), query: path ? { path } : {} })).json(),
      );
    }
    case 'set_component_state':
      return ctx.ok(
        await (
          await stateApi().$post({
            param: state(),
            json: { ops: a.ops, author: ctx.suggestionAuthor() },
          })
        ).json(),
      );
    case 'place_component':
      // An absent `name` or `headingId` is undefined here, and JSON drops
      // an undefined key, so neither reaches the wire.
      return ctx.ok(
        await (
          await api()['agent-components'].place.$post({
            param: doc(),
            json: {
              importPath: a.importPath,
              name: a.name,
              props: a.props,
              headingId: a.headingId,
              author: ctx.suggestionAuthor(),
            },
          })
        ).json(),
      );
    case 'request_component_grant':
      return ctx.ok(
        await (
          await api()['component-grants'].$post({
            param: doc(),
            json: {
              folder: a.folder,
              taskId: a.taskId,
              why: a.why,
              author: ctx.suggestionAuthor(),
            },
          })
        ).json(),
      );
    default:
      return undefined;
  }
}
