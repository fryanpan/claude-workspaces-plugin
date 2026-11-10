/**
 * The board's embed mapping: which `::name{block="…"}` doc paragraphs show a
 * live frame, and from which app (`@claude-workspaces/core/board-embeds`).
 *
 *   GET /workspaces/<ws>/embeds          → {workspaceId, embeds}
 *   PUT /workspaces/<ws>/embeds {embeds} → the same, after replacing it whole
 *
 * A member of a shared board may GET it (`BOARD_MEMBER_ROUTES` in
 * `middleware/host-guard.ts`): every doc on the board draws its frames from
 * it, and refused, a member saw the directive as plain text. The PUT stays
 * trusted-local, like the parallelism cap.
 *
 * An entry that names an origin is stored only when that origin is on the
 * deployment's allowlist, and is left out of a read once it no longer is. The
 * owner writes the allowlist to `<dataDir>/embed-origins.json`, a JSON array
 * of https origins; `CW_EMBED_ORIGINS` overrides it. It is read on every
 * request, so a change needs no restart, and a missing or invalid file
 * allows none.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  allowedEmbeds,
  embedOriginsFrom,
  embedOriginsFromJson,
  parseBoardEmbeds,
} from '@claude-workspaces/core/board-embeds';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

export const EMBED_ORIGINS_FILE = 'embed-origins.json';

function embedOrigins(dataDir: string): string[] {
  const env = process.env.CW_EMBED_ORIGINS;
  if (env !== undefined) return embedOriginsFrom(env);
  try {
    return embedOriginsFromJson(
      JSON.parse(readFileSync(join(dataDir, EMBED_ORIGINS_FILE), 'utf8')),
    );
  } catch {
    return [];
  }
}

export async function handleWorkspaceEmbeds(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { req, pathname, scope } = rq;
  if (!/^\/workspaces\/[^/]+\/embeds$/.test(pathname) || !scope) return undefined;
  if (req.method !== 'GET' && req.method !== 'PUT') return undefined;
  const { workspaceId } = scope;
  const origins = embedOrigins(ctx.dataDir);
  if (req.method === 'PUT') {
    const body = await ctx.safeJson(req);
    const parsed = parseBoardEmbeds(body?.embeds, origins);
    if (!parsed.ok) return ctx.j(400, { error: parsed.error });
    if (!ctx.taskStore.setBoardEmbeds(workspaceId, parsed.embeds)) {
      return ctx.j(404, { error: 'workspace not found' });
    }
  }
  const embeds = ctx.taskStore.boardEmbeds(workspaceId);
  if (!embeds) return ctx.j(404, { error: 'workspace not found' });
  return ctx.j(200, { workspaceId, embeds: allowedEmbeds(embeds, origins) });
}
