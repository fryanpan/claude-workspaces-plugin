/**
 * The typed routes another package's client reads, as types and nothing else.
 *
 * The MCP child's `hc<…>` clients (`packages/mcp/src/server-client.ts`) need
 * the TYPE of the app that answers, never its code, so every line here is an
 * `export type`. This is the one file under `routes/` another package may
 * import; `bun run check:imports` refuses the rest.
 *
 * They used to be re-exported from `server.ts` and again from `index.ts`, so
 * each new contract was an export-only edit to the router. A new contract is
 * one line here.
 */
export type { AgentMachineContract } from './agent-machine-contract.ts';
export type { AgentNotesContract } from './agent-notes-contract.ts';
export type { AttachmentsContract } from './attachments-contract.ts';
export type { DispatchesContract } from './dispatches-contract.ts';
export type { DocComponentsContract } from './doc-components-contract.ts';
export type { DocEditsContract } from './doc-edits-contract.ts';
export type { DocFileContract } from './doc-file-contract.ts';
export type { DocLifecycleContract } from './doc-lifecycle-contract.ts';
export type {
  DocThreadsContract,
  ScopedEditFields,
  ThreadByFindBody,
  ThreadCreateBody,
} from './doc-threads-contract.ts';
export type { InboxContract } from './inbox-contract.ts';
export type { LeadChatFilesContract } from './lead-chat-files-contract.ts';
export type { LeadMeetingContract } from './lead-meeting-contract.ts';
export type { LibraryFoldersContract } from './library-folders-contract.ts';
export type { MountsApi } from './mounts-api.ts';
export type { PersonContract, PlaceFields } from './person-contract.ts';
export type { ReviewItemsContract } from './review-items-contract.ts';
export type { ShareContract } from './share-contract.ts';
export type { NextAnswer, TaskBoardContract } from './task-board-contract.ts';
export type { TaskContentContract } from './task-content-contract.ts';
export type { TaskStateContract } from './task-state-contract.ts';
export type { WhiteboardContract } from './whiteboard-contract.ts';
export type { AttachAgentAnswer, WorkspaceAgentsContract } from './workspace-agents-contract.ts';
export type { WorkspaceBoardContract } from './workspace-board-contract.ts';
