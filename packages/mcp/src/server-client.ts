import type { Hono } from 'hono';
/**
 * Server routes, called through Hono's typed client.
 *
 * Each type named here is a server app or route contract
 * (`packages/server/src/routes/mounts-api.ts`, and the `*-contract.ts`
 * modules beside it, re-exported from the server's `index.ts`). Only the
 * TYPE crosses the package line — `import type` is erased from the bundle —
 * so a field the server renames, or a route it moves, fails
 * `bun run typecheck` at the tool that sends it.
 *
 * Every request still goes through `http`, the one REST call every tool
 * uses (`http-client.ts`): it resolves the server's address per request,
 * adds the agent token for the paths that need one, retries the one refusal
 * that is safe to retry, and throws on a non-2xx with the method, path and
 * status in front. So the client is given a placeholder origin, and its
 * `fetch` hands the method, path and body to `http` and wraps the parsed
 * answer back up for the client to read.
 *
 * `hc` does not encode path parameters, so a caller passes each one through
 * `encodeURIComponent`, as the hand-spelled paths did.
 */
import { hc } from 'hono/client';
import type {
  AgentNotesContract,
  AttachmentsContract,
  DocEditsContract,
  DocLifecycleContract,
  DocThreadsContract,
  MountsApi,
  ShareContract,
  TaskBoardContract,
  TaskContentContract,
  TaskStateContract,
} from '../../server/src/index.ts';

/** The REST call `http-client.ts` builds; throws on a non-2xx. */
type Http = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** Never dialled: `http` puts the real server's address in front of the path. */
const PLACEHOLDER_ORIGIN = 'http://claude-workspaces.invalid';

// biome-ignore lint/suspicious/noExplicitAny: hc's own bound on the app type.
function typedClient<App extends Hono<any, any, any>>(http: Http) {
  return hc<App>(PLACEHOLDER_ORIGIN, {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const data = await http(init?.method ?? 'GET', `${url.pathname}${url.search}`, body);
      return Response.json(data);
    },
  });
}

export const mountsClient = (http: Http) => typedClient<MountsApi>(http);
export const docThreadsClient = (http: Http) => typedClient<DocThreadsContract>(http);
export const docEditsClient = (http: Http) => typedClient<DocEditsContract>(http);
export const docLifecycleClient = (http: Http) => typedClient<DocLifecycleContract>(http);
export const attachmentsClient = (http: Http) => typedClient<AttachmentsContract>(http);
export const shareClient = (http: Http) => typedClient<ShareContract>(http);
export const agentNotesClient = (http: Http) => typedClient<AgentNotesContract>(http);
export const taskStateClient = (http: Http) => typedClient<TaskStateContract>(http);
export const taskContentClient = (http: Http) => typedClient<TaskContentContract>(http);
export const taskBoardClient = (http: Http) => typedClient<TaskBoardContract>(http);
