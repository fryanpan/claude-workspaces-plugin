/**
 * The contract for the whiteboard routes (`route-contract.ts` says what a
 * contract is). `whiteboard-routes.ts` serves all three. `create_whiteboard`
 * reads the new doc's id and links from the answer, so that answer is
 * declared; the scene and draw answers are passed to the agent whole.
 *
 * `author` is resolved by `authorFor`, so it is `unknown` here.
 */
import type { DocType } from '@claude-workspaces/core';
import { Hono } from 'hono';
import { answers, contractOnly, json } from './route-contract.ts';

export interface CreateWhiteboardBody {
  title?: string;
  author?: unknown;
}
/** `shapes` is checked whole by `parseShapes`; `point` null hides the pointer. */
export interface DrawOnWhiteboardBody {
  shapes: unknown;
  mode?: unknown;
  point?: unknown;
  author?: unknown;
}

export interface CreateWhiteboardAnswer {
  docId: string;
  /** The whiteboard's own page. */
  url: string;
  meta: { docId: string; type: DocType; reviewUrl?: string };
}

const DOC = '/workspaces/:ws/docs/:docId/whiteboard';

export const whiteboardContract = new Hono()
  .post(
    '/workspaces/:ws/whiteboards',
    json<CreateWhiteboardBody>(),
    answers<CreateWhiteboardAnswer>(),
  )
  .get(DOC, contractOnly)
  .post(DOC, json<DrawOnWhiteboardBody>(), contractOnly);

export type WhiteboardContract = typeof whiteboardContract;
