/**
 * Every route a contract declares is a route the server serves.
 *
 * A contract (`src/routes/route-contract.ts`) declares the routes the MCP's
 * typed client may call, and never serves them itself. So a declared path that
 * no family answers would typecheck in the MCP and fail at a session's first
 * call. This test holds each declared route to its row in
 * `fixtures/route-answers.json`, which `route-answers.test.ts` keeps true
 * against a real server, and requires that row to be answered by one of the
 * family handlers the contract names.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { agentNotesContract } from '../src/routes/agent-notes-contract.ts';
import { attachmentsContract } from '../src/routes/attachments-contract.ts';
import { dispatchesContract } from '../src/routes/dispatches-contract.ts';
import { docComponentsContract } from '../src/routes/doc-components-contract.ts';
import { docEditsContract } from '../src/routes/doc-edits-contract.ts';
import { docLifecycleContract } from '../src/routes/doc-lifecycle-contract.ts';
import { docThreadsContract } from '../src/routes/doc-threads-contract.ts';
import { inboxContract } from '../src/routes/inbox-contract.ts';
import { leadChatFilesContract } from '../src/routes/lead-chat-files-contract.ts';
import { libraryFoldersContract } from '../src/routes/library-folders-contract.ts';
import { personContract } from '../src/routes/person-contract.ts';
import { reviewItemsContract } from '../src/routes/review-items-contract.ts';
import { queryOf } from '../src/routes/route-contract.ts';
import { shareContract } from '../src/routes/share-contract.ts';
import { taskBoardContract } from '../src/routes/task-board-contract.ts';
import { taskContentContract } from '../src/routes/task-content-contract.ts';
import { taskStateContract } from '../src/routes/task-state-contract.ts';
import { whiteboardContract } from '../src/routes/whiteboard-contract.ts';
import { workspaceAgentsContract } from '../src/routes/workspace-agents-contract.ts';
import { workspaceBoardContract } from '../src/routes/workspace-board-contract.ts';

const answers = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'route-answers.json'), 'utf8'),
) as Record<string, string>;

/** Each contract, and the handlers that may answer what it declares. */
const CONTRACTS: Array<{ name: string; app: Hono; servedBy: string[] }> = [
  {
    name: 'doc threads',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: docThreadsContract as unknown as Hono<any>,
    servedBy: [
      'doc-threads-routes.ts:handleDocThreadRoutes',
      'doc-thread-linked-item.ts:handleDocThreadLinkedItemRoute',
      'doc-resource.ts:handleDocResourceCore',
      'docs.ts:handleDocPromoteRoute',
    ],
  },
  {
    name: 'doc edits',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: docEditsContract as unknown as Hono<any>,
    servedBy: ['doc-edit-routes.ts:handleDocEditRoutes'],
  },
  {
    name: 'doc lifecycle',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: docLifecycleContract as unknown as Hono<any>,
    servedBy: [
      'docs.ts:handleDocCreateListRoutes',
      'doc-resource.ts:handleDocResourceCore',
      'doc-edit-routes.ts:handleDocEditRoutes',
      'archive.ts:handleArchiveRoutes',
      'apps.ts:handleAppRoutes',
    ],
  },
  {
    name: 'attachments',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: attachmentsContract as unknown as Hono<any>,
    servedBy: [
      'workspaces-create-read.ts:handleWorkspaceCreateRead',
      'archive.ts:handleArchiveRoutes',
      'review-files.ts:handleReviewFileRoutes',
      'workspace-delete.ts:handleWorkspaceDelete',
    ],
  },
  {
    name: 'share',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: shareContract as unknown as Hono<any>,
    servedBy: [
      'auth-share.ts:handleAuthShareRoutes',
      'workspace-members.ts:handleWorkspaceMembers',
    ],
  },
  {
    name: 'agent notes',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: agentNotesContract as unknown as Hono<any>,
    servedBy: ['dispatch-and-notes.ts:handleDispatchAndNoteRoutes'],
  },
  {
    name: 'task state',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: taskStateContract as unknown as Hono<any>,
    servedBy: ['task-fields.ts:handleTaskFields', 'task-status-links.ts:handleTaskStatusAndLinks'],
  },
  {
    name: 'task content',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: taskContentContract as unknown as Hono<any>,
    servedBy: [
      'tasks-batch.ts:handleTaskBatch',
      'workspace-content.ts:handleWorkspaceContent',
      'task-done-when.ts:handleTaskDoneWhen',
      'task-status-links.ts:handleTaskStatusAndLinks',
    ],
  },
  {
    name: 'task board',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: taskBoardContract as unknown as Hono<any>,
    servedBy: [
      'workspace-next.ts:handleWorkspaceNext',
      'tasks-list-create.ts:handleTaskListCreate',
      'workspace-goals.ts:handleWorkspaceGoals',
    ],
  },
  {
    name: 'review items',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: reviewItemsContract as unknown as Hono<any>,
    servedBy: [
      'task-review-items.ts:handleTaskReviewItems',
      'task-review-withdraw.ts:handleTaskReviewWithdraw',
      'task-answers.ts:handleTaskAnswers',
      'task-review-ask-back.ts:handleTaskReviewMoreInfo',
      'workspace-home.ts:handleWorkspaceHome',
    ],
  },
  {
    name: 'library folders',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: libraryFoldersContract as unknown as Hono<any>,
    servedBy: ['workspace-library-folders.ts:handleLibraryFolderRoutes'],
  },
  {
    name: 'doc components',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: docComponentsContract as unknown as Hono<any>,
    servedBy: ['doc-component-agent.ts:handleDocComponentAgentRoute'],
  },
  {
    name: 'person',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: personContract as unknown as Hono<any>,
    servedBy: [
      'workspace-point.ts:handleWorkspacePoint',
      'agent-identity.ts:handleAgentIdentityRoutes',
      'private-messages.ts:handlePrivateMessageRoutes',
    ],
  },
  {
    name: 'whiteboard',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: whiteboardContract as unknown as Hono<any>,
    servedBy: [
      'whiteboard-routes.ts:handleWhiteboardCreateRoute',
      'whiteboard-routes.ts:handleWhiteboardRoutes',
    ],
  },
  {
    name: 'inbox',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: inboxContract as unknown as Hono<any>,
    servedBy: ['inbox.ts:handleInboxRoutes'],
  },
  {
    name: 'lead-chat files',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: leadChatFilesContract as unknown as Hono<any>,
    servedBy: ['workspace-lead-chat-files.ts:handleLeadChatFiles'],
  },
  {
    name: 'workspace board',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: workspaceBoardContract as unknown as Hono<any>,
    servedBy: [
      'workspaces-create-read.ts:handleWorkspaceCreateRead',
      'workspace-settings.ts:handleWorkspaceSettings',
      'workspace-content.ts:handleWorkspaceContent',
      'workspace-related.ts:handleWorkspaceRelated',
    ],
  },
  {
    name: 'workspace agents',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: workspaceAgentsContract as unknown as Hono<any>,
    servedBy: ['workspace-attachments.ts:handleWorkspaceAttachments'],
  },
  {
    name: 'dispatches',
    // biome-ignore lint/suspicious/noExplicitAny: a contract's schema type is irrelevant here.
    app: dispatchesContract as unknown as Hono<any>,
    servedBy: [
      'dispatch-and-notes.ts:handleDispatchAndNoteRoutes',
      'chat-audit-routes.ts:handleChatAuditRoutes',
    ],
  },
];

/** `METHOD /path` for every route the app declares, once each. */
function declared(app: Hono): string[] {
  return [...new Set(app.routes.map((r) => `${r.method} ${r.path}`))];
}

describe('route contracts', () => {
  for (const { name, app, servedBy } of CONTRACTS) {
    it(`declares only routes the server serves: ${name}`, () => {
      const routes = declared(app);
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        const answer = answers[route];
        expect(answer, `${route} has no row in route-answers.json`).toBeDefined();
        const by = answer?.split('| by ')[1] ?? '';
        expect(
          servedBy.some((handler) => by.includes(handler)),
          `${route} is answered by ${by}`,
        ).toBe(true);
      }
    });
  }

  // The control: a route no family serves fails the same check.
  it('refuses a declared route that no family answers', () => {
    const by = answers['POST /workspaces/:ws/docs/:docId/threads/:threadId/close'];
    expect(by).toBeUndefined();
    const unserved = answers['DELETE /api/attachments']?.split('| by ')[1] ?? '';
    expect(CONTRACTS[0]?.servedBy.some((h) => unserved.includes(h))).toBe(false);
  });
});

describe('queryOf', () => {
  it('reads the first value of a key, as URLSearchParams.get does', () => {
    const q = queryOf<{ goal?: string; limit?: string }>(
      new URL('http://x/w?goal=g-1&goal=g-2&limit=3'),
    );
    expect(q).toEqual({ goal: 'g-1', limit: '3' });
  });

  it('answers nothing for a key the request did not send, prototype names included', () => {
    const q = queryOf<{ constructor?: string; toString?: string }>(
      new URL('http://x/w?toString=1&__proto__=2'),
    );
    expect(q.constructor).toBeUndefined();
    expect(q.toString).toBe('1');
    expect(Object.getPrototypeOf(q)).toBeNull();
  });
});
