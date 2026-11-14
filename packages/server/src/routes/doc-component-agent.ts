import {
  type AgentResult,
  getComponentState,
  grantFolderFor,
  listComponents,
  placeComponent,
  setComponentState,
} from '../doc-components-agent.ts';
import { browserCannotBindBody, isBrowserRequest } from '../middleware/write-gate.ts';
import { proposalReply, proposingAgent } from '../share/access-proposals.ts';
import { boundFiles } from '../slow-fs.ts';
import {
  type DocResourceRouteRequest,
  type DocRoutesContext,
  parseSuggestionAuthor,
} from './docs-routes-context.ts';

/**
 * What an agent does to a bound `.mdx` doc's components
 * (`doc-components-agent.ts`), behind the MCP tools of the same names:
 *
 *   GET  docs/<id>/agent-components            — list_components
 *   GET  docs/<id>/agent-components/<cid>/state — get_component_state (`?path=`)
 *   POST docs/<id>/agent-components/<cid>/state — set_component_state `{ops, author}`
 *   POST docs/<id>/agent-components/place       — place_component
 *   POST docs/<id>/component-grants             — request_component_grant
 *
 * Trusted-local only. None of these is under `components/`, the prefix the
 * share host lets a visitor GET bundles from, so a visitor never reaches one;
 * each refuses a visitor itself as well. The writes refuse a browser, as
 * every agent write does: a page writes state over its own socket.
 *
 * `component-grants` never grants. It files an access card on the task the
 * agent names, through the same path a share call uses
 * (`share/access-proposals.ts`); only the owner's Approve at the access door
 * applies it.
 */

// The id is not decoded: a component id is only a-z, 0-9 and -, so an
// encoded one is refused as it stands.
const STATE = /^agent-components\/([^/]+)\/state$/;

const reply = <T>(j: DocRoutesContext['j'], res: AgentResult<T>): Response =>
  res.ok ? j(200, res.value) : j(res.status, { error: res.error });

export async function handleDocComponentAgentRoute(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const { req, visitor, rest, doc, docId, url } = rq;
  const { j } = ctx;
  const state = STATE.exec(rest);
  const ours =
    rest === 'agent-components' ||
    rest === 'agent-components/place' ||
    rest === 'component-grants' ||
    state !== null;
  if (!ours) return undefined;
  if (visitor) return j(403, { error: 'component tools are not available to share visitors' });

  if (req.method === 'GET') {
    if (rest === 'agent-components') return j(200, { docId, components: listComponents(doc) });
    if (state) {
      const path = url.searchParams.get('path') ?? undefined;
      return reply(j, getComponentState(doc, state[1] ?? '', path));
    }
    return j(405, { error: 'method not allowed' });
  }
  if (req.method !== 'POST' || rest === 'agent-components') {
    return j(405, { error: 'method not allowed' });
  }
  if (isBrowserRequest(req.headers)) return j(403, browserCannotBindBody());
  const body = await ctx.safeJson(req);
  const author = parseSuggestionAuthor(body);
  if (!author)
    return j(400, { error: 'author {id,name} is required: component writes are attributed' });

  if (state) {
    return reply(j, setComponentState(doc, state[1] ?? '', body?.ops, author.id));
  }
  if (rest === 'agent-components/place') {
    const res = await placeComponent(
      doc,
      {
        importPath: body?.importPath,
        name: body?.name,
        props: body?.props,
        headingId: body?.headingId,
      },
      { author: author.id, authorName: author.name, authorColor: author.color },
      {
        boundPath: ctx.docStore.boundPathOf(docId),
        applyBlockEdits: (edits, who) => ctx.docStore.applyBlockEdits(docId, edits, who),
        refresh: () => ctx.docStore.refreshComponents(doc),
      },
    );
    return reply(j, res);
  }

  // component-grants
  const taskId = typeof body?.taskId === 'string' ? body.taskId : '';
  const task = taskId ? ctx.taskStore.getTask(taskId) : undefined;
  if (!task || !ctx.workspacesOfDoc(docId).includes(task.workspaceId)) {
    return j(404, {
      error: 'task-not-on-board',
      message: 'taskId must name a task on a board this doc is on: the card is filed there.',
    });
  }
  const folder = await grantFolderFor(
    ctx.docStore.boundPathOf(docId),
    body?.folder,
    boundFiles.guards,
  );
  if (!folder.ok) return j(folder.status, { error: folder.error });
  if (ctx.docStore.componentGrants.covers(`${folder.value}/x`)) {
    return j(200, {
      granted: true,
      folder: folder.value,
      message: 'The owner already granted this folder.',
    });
  }
  if (!ctx.proposeAccess) {
    return j(403, { error: 'owner-only', message: 'This server files no access cards.' });
  }
  return proposalReply(
    j,
    ctx.proposeAccess({
      change: { op: 'component-folder', workspaceId: task.workspaceId, folder: folder.value },
      taskId,
      why: body?.why,
      actor: proposingAgent(author.name),
    }),
  );
}
