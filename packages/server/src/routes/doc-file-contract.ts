/**
 * The contract for a doc's title, metadata and file location (what a
 * contract is: `route-contract.ts`). `doc-title.ts`, `doc-metadata.ts`,
 * `doc-move.ts` and `doc-file-move.ts` serve these routes. Every answer is
 * passed to the agent whole, so none is declared.
 */
import { Hono } from 'hono';
import { contractOnly, json } from './route-contract.ts';

export interface DocTitleBody {
  title: string;
}
/** Field name to value; `null` clears a field. Checked against the schema. */
export interface DocMetadataBody {
  fields: Record<string, unknown>;
}
/** A path inside the project's notes home, checked by `moveDocToProject`. */
export interface DocMoveBody {
  relPath: string;
}
/** Checked by `relocateDocFile`. */
export interface DocFileMoveBody {
  path: string;
  mode: string;
}

const DOC = '/workspaces/:ws/docs/:docId';

export const docFileContract = new Hono()
  .put(`${DOC}/title`, json<DocTitleBody>(), contractOnly)
  .get(`${DOC}/metadata`, contractOnly)
  .put(`${DOC}/metadata`, json<DocMetadataBody>(), contractOnly)
  .post(`${DOC}/move`, json<DocMoveBody>(), contractOnly)
  .post(`${DOC}/move-file`, json<DocFileMoveBody>(), contractOnly);

export type DocFileContract = typeof docFileContract;
