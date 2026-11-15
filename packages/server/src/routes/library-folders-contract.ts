/**
 * The contract for a board's Library folder routes the MCP calls
 * (`route-contract.ts` says what a contract is). `workspace-library-folders.ts`
 * serves every one, and each branch reads its body as the type declared
 * here. No folder tool reads a field of the answer, so none is declared.
 */
import { Hono } from 'hono';
import { contractOnly, json } from './route-contract.ts';

/** `parentId` absent, null or empty is the top level. */
export interface CreateFolderBody {
  name: string;
  parentId: string | null;
}
export interface RenameFolderBody {
  name: string;
}
export interface MoveFolderBody {
  parentId: string | null;
}
/** `folderId` null takes the doc out of every folder. */
export interface DocFolderBody {
  folderId: string | null;
}

const BOARD = '/workspaces/:ws/library';
const FOLDER = `${BOARD}/folders/:folderId`;

export const libraryFoldersContract = new Hono()
  .get(`${BOARD}/folders`, contractOnly)
  .post(`${BOARD}/folders`, json<CreateFolderBody>(), contractOnly)
  .post(`${FOLDER}/rename`, json<RenameFolderBody>(), contractOnly)
  .post(`${FOLDER}/move`, json<MoveFolderBody>(), contractOnly)
  .post(`${FOLDER}/archive`, contractOnly)
  .post(`${FOLDER}/unarchive`, contractOnly)
  .put(`${BOARD}/docs/:docId/folder`, json<DocFolderBody>(), contractOnly);

export type LibraryFoldersContract = typeof libraryFoldersContract;
