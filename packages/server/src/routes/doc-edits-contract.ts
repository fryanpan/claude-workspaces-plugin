/**
 * The contract for a doc's edit and anchor routes the MCP calls
 * (`route-contract.ts` says what a contract is). `doc-edit-routes.ts` serves
 * every one, and each branch reads its body as the type declared here.
 */
import type { prose } from '@claude-workspaces/core';
import { Hono } from 'hono';
import type { ScopedEditFields } from './doc-threads-contract.ts';
import { answers, contractOnly, json } from './route-contract.ts';

export interface FindAndReplaceBody extends ScopedEditFields {
  find: string;
  replace: string;
  contextBefore?: string;
  contextAfter?: string;
  occurrence?: number;
  replaceAll?: boolean;
  parseInlineMarks?: boolean;
  suggest?: boolean;
}
export interface ResolveAllSuggestionsBody {
  action: 'accept' | 'reject';
  authorId?: string;
}
export interface CreateAnchorBody {
  find: string;
  contextBefore?: string;
  contextAfter?: string;
  occurrence?: number;
  label?: string;
}
export interface EditAtAnchorBody extends ScopedEditFields {
  kind: 'replace' | 'insert_after';
  text: string;
}
export interface InsertBlocksAtAnchorBody extends ScopedEditFields {
  markdown: string;
  placement?: 'after-block' | 'top-level';
}
export interface BlockEditsBody {
  edits: unknown;
  author?: unknown;
}
export interface DeleteBlockAtAnchorBody extends ScopedEditFields {
  threadId?: string;
  anchorId?: string;
}
export interface DeleteBlocksInRangeBody extends ScopedEditFields {
  startFind: string;
  endFind: string;
  contextBefore?: string;
  contextAfter?: string;
  startOccurrence?: number;
  endOccurrence?: number;
}
export interface DeleteSectionBody extends ScopedEditFields {
  heading: string;
  level?: number;
  occurrence?: number;
}

/**
 * The one answer here an agent reads a field of: `anchorId`, which every
 * later anchor call names. The others stay untyped (see the PR that added
 * this contract for the list).
 */
export type CreateAnchorAnswer = prose.CreateAnchorResult;

const DOC = '/workspaces/:ws/docs/:docId';
const ANCHOR = `${DOC}/agent_anchors/:anchorId`;
const SUGGESTION = `${DOC}/suggestions/:sid`;

export const docEditsContract = new Hono()
  .post(`${DOC}/find_and_replace`, json<FindAndReplaceBody>(), contractOnly)
  .get(`${DOC}/suggestions`, contractOnly)
  .post(`${SUGGESTION}/accept`, contractOnly)
  .post(`${SUGGESTION}/reject`, contractOnly)
  .post(`${DOC}/suggestions/resolve_all`, json<ResolveAllSuggestionsBody>(), contractOnly)
  .post(`${DOC}/agent_anchors`, json<CreateAnchorBody>(), answers<CreateAnchorAnswer>())
  .post(`${ANCHOR}/edit`, json<EditAtAnchorBody>(), contractOnly)
  .post(`${ANCHOR}/insert_blocks`, json<InsertBlocksAtAnchorBody>(), contractOnly)
  .delete(ANCHOR, contractOnly)
  .post(`${DOC}/block_edits`, json<BlockEditsBody>(), contractOnly)
  .post(`${DOC}/delete_block_at_anchor`, json<DeleteBlockAtAnchorBody>(), contractOnly)
  .post(`${DOC}/delete_blocks_in_range`, json<DeleteBlocksInRangeBody>(), contractOnly)
  .post(`${DOC}/delete_section`, json<DeleteSectionBody>(), contractOnly);

export type DocEditsContract = typeof docEditsContract;
