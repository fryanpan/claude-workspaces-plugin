/**
 * The contract for the attachment-set routes the MCP calls, and for deleting
 * a board (`route-contract.ts` says what a contract is). Four families serve
 * them: `workspaces-create-read.ts` (a folder bind, a diff review),
 * `archive.ts` (archive, unarchive, delete, the archived list),
 * `review-files.ts` (refresh, regroup) and `workspace-delete.ts`.
 */
import { Hono } from 'hono';
import type { BoardWorkspace } from '../tasks.ts';
import { answers, contractOnly, json, query } from './route-contract.ts';

type ProducedBy = { agentId?: string; sessionId?: string };
type Groups = Array<{ title: string; paths: string[]; details?: string }>;

/** `POST /workspaces` takes two shapes: a folder bind, or a board by name. */
export interface WorkspacesPostBody {
  folderPath?: string;
  /** The set id to re-use; `workspaceId` is its name from before the rename. */
  setId?: string;
  workspaceId?: string;
  hubWorkspaceId?: string;
  title?: string;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  owner?: string;
  producedBy?: ProducedBy;
  privacy?: string;
  name?: string;
  leadAgentId?: string;
  author?: unknown;
}
export interface DiffReviewBody {
  repo: string;
  base?: string;
  target?: string;
  reviewId?: string;
  title?: string;
  exclude?: string[];
  groups?: Groups;
  maxFiles?: number;
  owner?: string;
  producedBy?: ProducedBy;
}
export interface ArchiveSetBody {
  author?: unknown;
  reason?: string;
}
export interface SetGroupsBody {
  groups: Groups;
}

/**
 * The answers a tool reads a field of: a folder bind's `workspaceId` and a
 * diff review's `reviewId`, which `subscribe` watches. Each names the other
 * fields its route writes beside the bind result it spreads in, so a rename
 * of either id in the bind result fails typecheck here.
 */
export interface FolderBindAnswer {
  workspaceId: string;
  setId: string;
  hubWorkspaceId?: string;
  privacy: unknown;
  privacyNote: unknown;
  files: unknown;
  links: unknown;
  entryUrl?: string;
  url?: string;
}
export interface BoardCreateAnswer {
  workspace: BoardWorkspace;
  url: string;
}
export interface DiffReviewAnswer {
  reviewId: string;
  setId: string;
  hubWorkspaceId?: string;
  files: unknown;
  links?: unknown;
  entryUrl?: string;
  url?: string;
}

const SET = '/workspaces/:ws/attachments/:setId';
type DeleteQuery = { force?: 'true'; purge?: 'true' };

export const attachmentsContract = new Hono()
  .post('/workspaces', json<WorkspacesPostBody>(), answers<FolderBindAnswer | BoardCreateAnswer>())
  // `purge` reaches no reader on a board delete: the review branch that read
  // it is gone. delete_workspace still sends it.
  .delete('/workspaces/:ws', query<DeleteQuery>(), contractOnly)
  .post('/workspaces/:ws/attachments', json<DiffReviewBody>(), answers<DiffReviewAnswer>())
  .get('/workspaces/:ws/attachments', query<{ archived: 'true' }>(), contractOnly)
  .delete(SET, query<DeleteQuery>(), contractOnly)
  .post(`${SET}/archive`, json<ArchiveSetBody>(), contractOnly)
  .post(`${SET}/unarchive`, json<ArchiveSetBody>(), contractOnly)
  .post(`${SET}/refresh`, json<Record<string, never>>(), contractOnly)
  .post(`${SET}/groups`, json<SetGroupsBody>(), contractOnly);

export type AttachmentsContract = typeof attachmentsContract;
