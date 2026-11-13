import { readFileSync } from 'node:fs';
import type { DocResourceRouteRequest, DocRoutesContext } from './docs-routes-context.ts';

/**
 * A built component of a bound `.mdx` doc, as the doc page imports it.
 *
 *   GET /workspaces/<ws>/docs/<docId>/components/<hash>.js
 *
 * `<hash>` is the bundle's content hash (32 hex). It is served only while
 * this doc's `componentBuilds` map names it (`doc-component-builds.ts`), so a
 * doc's address reaches its own components and no other doc's; the hash
 * shape is checked before anything is read, and the file is read from the
 * server's data dir, never from a path the request spells.
 *
 * Gate: `share-scope`. The host guard admits `components/*` on a doc only when
 * the doc is inside the shared board, for GET and HEAD
 * (`docSubrouteAllowed`, `middleware/host-guard.ts`): a component is part of
 * what the doc displays, as its images are.
 *
 * A hash is a fixed body, so the answer is `immutable`. `nosniff` and
 * `Cross-Origin-Resource-Policy: same-origin` keep another site from loading
 * it as its own script.
 */
export const DOC_COMPONENTS_SEGMENT = 'components';

const ALWAYS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
};

export async function handleDocComponentsRoute(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const { rest, req, doc } = rq;
  if (!rest.startsWith(`${DOC_COMPONENTS_SEGMENT}/`)) return undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return ctx.j(405, { error: 'method not allowed' });
  }
  const m = /^([a-f0-9]{32})\.js$/.exec(rest.slice(DOC_COMPONENTS_SEGMENT.length + 1));
  const file = m?.[1] ? ctx.docStore.componentBundlePath(doc, m[1]) : null;
  if (!file) return ctx.j(404, { error: 'no such component build on this doc' });
  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return ctx.j(404, { error: 'no such component build on this doc' });
  }
  const headers = {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'private, max-age=31536000, immutable',
    ...ALWAYS,
  };
  if (req.method === 'HEAD') return new Response(null, { headers });
  return new Response(body, { headers });
}
