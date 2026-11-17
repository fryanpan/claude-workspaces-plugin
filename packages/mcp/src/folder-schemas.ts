/**
 * The Library folder verbs as `tools/list` advertises them. Spread into
 * `TOOL_LIST` (`tool-schemas.ts`); the behaviour is `tools/folders.ts`, and
 * the rules are the server's `library-folders.ts`.
 */
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

const WORKSPACE_ID = {
  type: 'string',
  description: 'The board whose Library holds the folders.',
} as const;

const FOLDER_ID = {
  type: 'string',
  description: 'The folder id that list_folders or create_folder returned. Meetings is "meetings".',
} as const;

const PARENT_ID = {
  type: ['string', 'null'],
  description: 'The folder to put it in. null or omitted is the top level.',
} as const;

/** What every folder verb answers, said once. */
const ANSWERS =
  'Returns the board’s live folders as {id, name, parentId, path}. A person with the Library open sees the change within a second.';

export const FOLDER_TOOLS: ListToolsResult['tools'] = [
  {
    name: 'list_folders',
    description: `List a board's Library folders. Meetings is built in: new meetings land in it, and it cannot be moved or archived. ${ANSWERS}`,
    inputSchema: {
      type: 'object',
      properties: { workspaceId: WORKSPACE_ID },
      required: ['workspaceId'],
    },
  },
  {
    name: 'create_folder',
    description: `Make a folder in a board's Library, at the top level or inside another folder. A name already used in the same place is refused. ${ANSWERS}`,
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: WORKSPACE_ID,
        name: { type: 'string', description: 'At most 80 characters, no slash.' },
        parentId: PARENT_ID,
      },
      required: ['workspaceId', 'name'],
    },
  },
  {
    name: 'rename_folder',
    description: `Rename a Library folder. A name already used beside it is refused. ${ANSWERS}`,
    inputSchema: {
      type: 'object',
      properties: { workspaceId: WORKSPACE_ID, folderId: FOLDER_ID, name: { type: 'string' } },
      required: ['workspaceId', 'folderId', 'name'],
    },
  },
  {
    name: 'move_folder',
    description: `Move a Library folder, with everything in it, into another folder or to the top level. ${ANSWERS}`,
    inputSchema: {
      type: 'object',
      properties: { workspaceId: WORKSPACE_ID, folderId: FOLDER_ID, parentId: PARENT_ID },
      required: ['workspaceId', 'folderId'],
    },
  },
  {
    name: 'archive_folder',
    description: `Archive a Library folder. Reversible with unarchive_folder: its docs and subfolders show as in no folder until then, and nothing is deleted. ${ANSWERS}`,
    inputSchema: {
      type: 'object',
      properties: { workspaceId: WORKSPACE_ID, folderId: FOLDER_ID },
      required: ['workspaceId', 'folderId'],
    },
  },
  {
    name: 'unarchive_folder',
    description: `Bring back an archived Library folder with its docs and subfolders where they were. ${ANSWERS}`,
    inputSchema: {
      type: 'object',
      properties: { workspaceId: WORKSPACE_ID, folderId: FOLDER_ID },
      required: ['workspaceId', 'folderId'],
    },
  },
  {
    name: 'move_doc_to_folder',
    description: `File a doc on this board in a Library folder, or in no folder with folderId null. Board data only: the doc's file, path and id do not change. list_docs rows name each doc's folder. ${ANSWERS}`,
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: WORKSPACE_ID,
        docId: { type: 'string' },
        folderId: { ...FOLDER_ID, type: ['string', 'null'] },
      },
      required: ['workspaceId', 'docId', 'folderId'],
    },
  },
];
