/**
 * The contract for the routes the MCP calls to make, read, rewrite, archive
 * and delete a doc, and to attach an app (`route-contract.ts` says what a
 * contract is). Five families serve them: `docs.ts` (create, list),
 * `doc-resource.ts` (content, status, delete), `doc-edit-routes.ts`
 * (rewrite, reparse), `archive.ts` and `apps.ts`.
 */
import type { DocType } from '@claude-workspaces/core';
import { Hono } from 'hono';
import { answers, contractOnly, json, query } from './route-contract.ts';

export interface DocCreateBody {
  docId: string;
  /** The route refuses `app` and `diff`, which have their own. */
  type?: DocType;
  sourceUrl?: string;
  title?: string;
  setId?: string;
  webhookUrl?: string;
  owner?: string;
  workspaceId?: string;
  relPath?: string;
  workspaceRoot?: string;
  producedBy?: { agentId?: string; sessionId?: string };
  checkout?: string;
}
export interface SetContentBody {
  markdown: string;
  author?: unknown;
  confirmOverwriteHumanEdits?: boolean;
}
export interface ArchiveDocBody {
  author?: unknown;
  reason?: string;
}
export interface AppAttachBody {
  docId: string;
  origin: string;
  title?: string;
  owner?: string;
  producedBy?: { agentId?: string; sessionId?: string };
  servesPrefix?: boolean;
}
export type ListDocsQuery = {
  kind?: string;
  query?: string;
  sourcePrefix?: string;
  limit?: string;
  cursor?: string;
  full?: '1';
};

/**
 * The one answer here a tool reads a field of: `docId`, the id the server
 * gave the doc, which the attach tools then watch. The others stay untyped.
 */
export interface DocCreateAnswer {
  warning?: string;
  linkWarning?: unknown;
  docId: string;
  url?: string;
  meta: unknown;
  hubWorkspaceId?: string;
  attached?: unknown;
}

const BOARD = '/workspaces/:ws';
const DOC = `${BOARD}/docs/:docId`;

export const docLifecycleContract = new Hono()
  .get(`${BOARD}/docs`, query<ListDocsQuery>(), contractOnly)
  .post(`${BOARD}/docs`, json<DocCreateBody>(), answers<DocCreateAnswer>())
  .get(`${DOC}/content`, query<{ reader?: string }>(), contractOnly)
  .post(`${DOC}/content`, json<SetContentBody>(), contractOnly)
  .get(`${DOC}/status`, contractOnly)
  .post(`${DOC}/reparse_from_disk`, contractOnly)
  .delete(DOC, query<{ force?: 'true' }>(), contractOnly)
  .post(`${DOC}/archive`, json<ArchiveDocBody>(), contractOnly)
  .post(`${DOC}/unarchive`, json<ArchiveDocBody>(), contractOnly)
  .post(`${BOARD}/apps`, json<AppAttachBody>(), contractOnly);

export type DocLifecycleContract = typeof docLifecycleContract;
