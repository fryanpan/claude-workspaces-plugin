/**
 * The contract for a doc's thread routes the MCP calls (`route-contract.ts`
 * says what a contract is). The routes are served by `doc-threads-routes.ts`,
 * `doc-thread-linked-item.ts` (linked-items) and `docs.ts` (promote), and
 * each branch reads its body as the type declared here.
 *
 * A field typed `unknown` is one the server parses and refuses itself
 * (an author, a review payload), so the contract names it without
 * constraining its shape.
 */
import { Hono } from 'hono';
import { contractOnly, json, query } from './route-contract.ts';

/** The two fields every scoped edit's guard reads (`scopedEditGuard`). */
export interface ScopedEditFields {
  author?: unknown;
  confirmOverwriteHumanEdits?: boolean;
}

export interface ThreadCommentBody {
  author?: unknown;
  text: string;
  review?: unknown;
  to?: unknown;
}
export interface ThreadAnswerBody {
  author?: unknown;
  commentId: string;
  text?: string;
  optionId?: string;
}
export interface ThreadEditCommentBody {
  author?: unknown;
  commentId: string;
  text: string;
  reason?: string;
  voice?: unknown;
}
export interface ThreadReviseBody {
  author?: unknown;
  commentId: string;
  headline?: string;
  detail?: string;
  options?: unknown;
  lessSpecific?: unknown;
  revisedRange?: unknown;
}
export interface ThreadWithdrawBody {
  author?: unknown;
  commentId: string;
  reason?: string;
}
export interface ThreadAuthorBody {
  author?: unknown;
}
export interface ThreadProgressBody {
  author?: unknown;
  state: 'working' | 'done' | 'open';
}
export interface ThreadSummaryBody {
  force?: boolean;
}
export interface ThreadRewriteRegionBody extends ScopedEditFields {
  replacement: string;
  parseInlineMarks?: boolean;
  suggest?: boolean;
}
export interface ThreadInsertAfterBody extends ScopedEditFields {
  text: string;
}
export interface ThreadInsertBlocksAfterBody extends ScopedEditFields {
  markdown: string;
  placement?: 'after-block' | 'top-level';
}
export interface ThreadLinkedItemBody {
  author?: unknown;
  item: unknown;
  text?: string;
}
export interface ThreadPromoteBody {
  author?: unknown;
  workspaceId?: string;
  quote?: string;
  title?: string;
  body?: string;
  order?: unknown;
  assignee?: string;
  assigneeKind?: 'person' | 'agent';
  needs?: 'action' | 'decision';
  goal?: string;
  dueAt?: number;
  links?: unknown;
  options?: unknown;
}

const DOC = '/workspaces/:ws/docs/:docId';
const THREAD = `${DOC}/threads/:threadId`;

export const docThreadsContract = new Hono()
  .get(`${DOC}/threads`, query<{ status?: string }>(), contractOnly)
  .get(THREAD, contractOnly)
  .post(`${THREAD}/comments`, json<ThreadCommentBody>(), contractOnly)
  .post(`${THREAD}/answer`, json<ThreadAnswerBody>(), contractOnly)
  .post(`${THREAD}/edit-comment`, json<ThreadEditCommentBody>(), contractOnly)
  .post(`${THREAD}/revise`, json<ThreadReviseBody>(), contractOnly)
  .post(`${THREAD}/withdraw`, json<ThreadWithdrawBody>(), contractOnly)
  .post(`${THREAD}/withdraw/undo`, json<ThreadWithdrawBody>(), contractOnly)
  .post(`${THREAD}/summary`, json<ThreadSummaryBody>(), contractOnly)
  // The MCP sends these two with no body; a browser's author is read by the
  // handler as `ThreadAuthorBody`.
  .post(`${THREAD}/resolve`, contractOnly)
  .post(`${THREAD}/progress`, json<ThreadProgressBody>(), contractOnly)
  .post(`${THREAD}/reopen`, contractOnly)
  .post(`${THREAD}/rewrite_region`, json<ThreadRewriteRegionBody>(), contractOnly)
  .post(`${THREAD}/insert_after`, json<ThreadInsertAfterBody>(), contractOnly)
  .post(`${THREAD}/insert_blocks_after`, json<ThreadInsertBlocksAfterBody>(), contractOnly)
  .post(`${THREAD}/linked-items`, json<ThreadLinkedItemBody>(), contractOnly)
  .post(`${THREAD}/promote`, json<ThreadPromoteBody>(), contractOnly);

export type DocThreadsContract = typeof docThreadsContract;
