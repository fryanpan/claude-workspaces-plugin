/**
 * ── The board app: the workspace scope and the families below it (M12) ──
 *
 * The workspace scope (the app's first middleware, below), then the whole
 * board run that used to be `request-chain-board.ts`: docs,
 * whiteboards, attached apps, the board's own routes, tasks, goals, the
 * thread promote, dispatches and notes, chat-audit, the Library, the doc
 * move, agent attachments, archive, the board delete, a review's files,
 * meetings and the calendar, and one doc's resource routes.
 *
 * WHY A SECOND APP. Every family here reads the workspace scope, which is
 * resolved below the stream block. The front app (`hono-families.ts`) is
 * tried above that block, so these cannot join it without overtaking the
 * upgrades. This app is tried exactly where the scope was, right below the
 * stream block, with the gates' proof in `c.env` and the scope in `c.var`;
 * the tail (`hono-tail-families.ts`) is registered after these families.
 *
 * ORDER. The families are registered in the run's order, and Hono runs the
 * middleware that match one address in registration order, so a family is
 * still tried after every family above it. That keeps the run's one
 * load-bearing position: every `…/docs/<id>/meetings…` pattern is tried
 * before the doc resource catch-all, which would otherwise swallow them all.
 *
 * PATTERNS. Each family's patterns are a superset of what its handler
 * claims, derived from the handler's own `matchRest` / `restIs` tests (a
 * remainder under `/workspaces/<id>/`) and, for the meetings, its exact
 * `/api/calendar…` and `/api/meeting-engines` paths. The three composites
 * that answer dozens of remainders — the board's own routes, tasks, and agent
 * attachments — claim `/workspaces/*`, and their handlers decide. An address
 * a handler declines goes to `next()`, as in the front.
 */
import type { Context, Hono } from 'hono';
import type { HonoBoardAppEnv, HonoBoardFamily } from '../hono-env.ts';
import { type WorkspaceScopeDeps, resolveWorkspaceScope } from '../middleware/workspace-scope.ts';
import { askedAddress, renderBoardMemberNotFound, renderBoardNotFound } from '../shells.ts';
import type { BoardWorkspace } from '../tasks.ts';
import { type AppRoutesContext, handleAppRoutes } from './apps.ts';
import type { createArchiveRoutes } from './archive.ts';
import { type ChatAuditRoutesContext, handleChatAuditRoutes } from './chat-audit-routes.ts';
import { type DocMoveRoutesContext, handleDocMoveRoute } from './doc-move.ts';
import type { DocRoutesContext } from './docs-routes-context.ts';
import {
  handleDocCreateListRoutes,
  handleDocPromoteRoute,
  handleDocResourceRoutes,
} from './docs.ts';
import { type HonoFamiliesContext, chainValues, claimWith } from './hono-families.ts';
import {
  type MeetingCalendarRoutesContext,
  handleMeetingCalendarRoutes,
} from './meetings-calendar.ts';
import { type ReviewFileRoutesContext, handleReviewFileRoutes } from './review-files.ts';
import { type TaskRoutesContext, handleDispatchAndNoteRoutes, handleTaskRoutes } from './tasks.ts';
import { handleWhiteboardCreateRoute } from './whiteboard-routes.ts';
import { handleLibraryFolderRoutes } from './workspace-library-folders.ts';
import { handleLibraryViewRoutes } from './workspace-library-views.ts';
import { type LibraryRoutesContext, handleLibraryRoutes } from './workspace-library.ts';
import {
  type WorkspaceRoutesContext,
  handleWorkspaceAttachmentRoutes,
  handleWorkspaceDeleteRoute,
  handleWorkspaceGoalRoutes,
  handleWorkspaceRoutes,
} from './workspaces.ts';

/** Everything long-lived the board families read. Built once by `server.ts`. */
export interface HonoBoardFamiliesContext
  extends Pick<HonoFamiliesContext, 'requireSignInToWrite' | 'policyFor'> {
  docRoutesCtx: DocRoutesContext;
  appRoutesCtx: AppRoutesContext;
  workspaceRoutesCtx: WorkspaceRoutesContext;
  taskRoutesCtx: TaskRoutesContext;
  chatAuditRoutesCtx: ChatAuditRoutesContext;
  libraryRoutesCtx: LibraryRoutesContext;
  docMoveRoutesCtx: DocMoveRoutesContext;
  handleArchiveRoutes: ReturnType<typeof createArchiveRoutes>['handleArchiveRoutes'];
  reviewFileRoutesCtx: ReviewFileRoutesContext;
  meetingCalendarRoutesCtx: MeetingCalendarRoutesContext;
  /** What the workspace scope reads: the board, and which boards hold a row. */
  workspaceRecord: WorkspaceScopeDeps<BoardWorkspace>['workspaceRecord'];
  workspacesOfMember: WorkspaceScopeDeps<BoardWorkspace>['workspacesOfMember'];
  j: (status: number, body: unknown) => Response;
}

/** The per-request values the board run read, off `c.env`. */
function boardValues(c: Context<HonoBoardAppEnv>, ctx: HonoBoardFamiliesContext) {
  const base = chainValues(c, ctx);
  const { gate, attribution, mayMintAppVoice } = c.env;
  const { scope } = c.var;
  return {
    ...base,
    scope,
    gate,
    attribution,
    mayMintAppVoice,
    leadBoard: gate.leadBoard,
    metaFor: gate.metaFor,
    roleFor: gate.roleFor,
    requireOwner: gate.requireOwner,
    accessEmail: gate.accessEmail,
    refuseCategoryAuthor: attribution.refuseCategoryAuthor,
    withTaskChips: attribution.withTaskChips,
    requestOriginFor: base.requestOrigin,
    /** What this request proved about a person, for the answer doors. */
    answerProof: {
      req: base.req,
      provenIdentityFor: base.provenIdentityFor,
      widgetIdentity: base.widgetIdentity,
      requestOrigin: base.requestOrigin,
    },
  };
}

type BoardValues = ReturnType<typeof boardValues>;
type Answer = Response | null | undefined;

function claim(
  app: Hono<HonoBoardAppEnv>,
  ctx: HonoBoardFamiliesContext,
  patterns: readonly string[],
  answer: (v: BoardValues) => Answer | Promise<Answer>,
): void {
  claimWith(app, (c) => boardValues(c, ctx), patterns, answer);
}

/** Every address under a board, and the bare collection. */
const ANY_BOARD = ['/workspaces', '/workspaces/*'];

/** The common fields most board handlers take. */
const scoped = (v: BoardValues) => ({
  scope: v.scope,
  req: v.req,
  url: v.url,
  pathname: v.pathname,
  visitor: v.visitor,
  authorFor: v.authorFor,
  roleFor: v.roleFor,
  requireOwner: v.requireOwner,
});

/**
 * The workspace scope (`middleware/workspace-scope.ts`), as the app's first
 * middleware. It ran in the chain at exactly this point — below the stream
 * block, above every board family — and resolves every `/workspaces/<id>/…`
 * request once: does the board exist, and does the row named under it
 * belong to it. A refusal is the answer and no family sees the request;
 * otherwise the scope goes into `c.var` for the families below, and `pass`
 * (not a board path, or a board page) leaves it undefined. Whether the
 * CALLER may reach the board is not asked here: `shareScopeAllows` in the
 * host guard has already answered it.
 */
function workspaceScope(ctx: HonoBoardFamiliesContext): HonoBoardFamily {
  return (app) =>
    app.use('*', async (c, next) => {
      const req = c.req.raw;
      const url = new URL(req.url);
      const scoped = resolveWorkspaceScope(
        {
          workspaceRecord: ctx.workspaceRecord,
          workspacesOfMember: ctx.workspacesOfMember,
          j: ctx.j,
          // A browser asked for a page; answer it with one — naming the
          // board it can go back to, which is the whole difference between
          // a dead end and a wrong turn. Unless the BOARD is what is
          // missing, in which case there is nowhere on it to go and the
          // board's own not-found page is the honest answer: offering to
          // open a board that does not exist is a second dead end.
          notFoundPage: (address) =>
            new Response(
              address.boardExists
                ? renderBoardMemberNotFound(address.workspaceId, askedAddress(url))
                : renderBoardNotFound(address.workspaceId, askedAddress(url)),
              { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
            ),
        },
        { pathname: url.pathname, method: req.method, url, accept: req.headers.get('accept') },
      );
      if (scoped.kind === 'refused') return scoped.response;
      c.set('scope', scoped.kind === 'scope' ? scoped.scope : undefined);
      await next();
      return undefined;
    });
}

/**
 * The scope, then the families, in the order the board run used to try
 * them. `server.ts` appends the tail (`hono-tail-families.ts`) after these.
 */
export function honoBoardFamilies(ctx: HonoBoardFamiliesContext): HonoBoardFamily[] {
  return [
    workspaceScope(ctx),
    // routes/docs.ts and routes/whiteboard-routes.ts — `docs` (list and
    // create) and `whiteboards` (create), two exact remainders.
    (app) =>
      claim(app, ctx, ['/workspaces/:ws/docs', '/workspaces/:ws/whiteboards'], async (v) => {
        const docRq = {
          ...scoped(v),
          leadBoard: v.leadBoard,
          refuseCategoryAuthor: v.refuseCategoryAuthor,
          metaFor: v.metaFor,
          withTaskChips: v.withTaskChips,
        };
        return (
          (await handleDocCreateListRoutes(ctx.docRoutesCtx, docRq)) ??
          (await handleWhiteboardCreateRoute(ctx.docRoutesCtx, docRq))
        );
      }),
    // routes/apps.ts — `apps` (attach) and `apps/<id>/…` (an app's own paths).
    (app) =>
      claim(app, ctx, ['/workspaces/:ws/apps', '/workspaces/:ws/apps/*'], (v) =>
        handleAppRoutes(ctx.appRoutesCtx, {
          req: v.req,
          url: v.url,
          scope: v.scope,
          visitor: Boolean(v.visitor),
          member: v.visitor && !v.boardAgent ? (v.gate.visitorHome?.signedInAs ?? null) : null,
          mayMintAppVoice: v.mayMintAppVoice(),
          requestOrigin: v.requestOrigin,
        }),
      ),
    // routes/workspaces.ts — the board's own routes: created, read, and every
    // field on it written. A composite of a dozen modules; its handler decides.
    (app) =>
      claim(app, ctx, ANY_BOARD, (v) =>
        handleWorkspaceRoutes(ctx.workspaceRoutesCtx, {
          ...scoped(v),
          leadBoard: v.leadBoard,
          boardAgent: v.boardAgent,
          accessEmail: v.accessEmail,
          provenIdentityFor: v.provenIdentityFor,
          requestOriginFor: v.requestOriginFor,
          answerProof: v.answerProof,
        }),
      ),
    // routes/tasks.ts — the task routes, another composite.
    (app) =>
      claim(app, ctx, ANY_BOARD, (v) =>
        handleTaskRoutes(ctx.taskRoutesCtx, {
          ...scoped(v),
          refuseCategoryAuthor: v.refuseCategoryAuthor,
          provenIdentityFor: v.provenIdentityFor,
          requestOriginFor: v.requestOriginFor,
          answerProof: v.answerProof,
        }),
      ),
    // routes/workspace-goals.ts — `goals` and below it.
    (app) =>
      claim(app, ctx, ['/workspaces/:ws/goals', '/workspaces/:ws/goals/*'], (v) =>
        handleWorkspaceGoalRoutes(ctx.workspaceRoutesCtx, {
          ...scoped(v),
          accessEmail: v.accessEmail,
        }),
      ),
    // routes/docs.ts — promote a thread to a task.
    (app) =>
      claim(app, ctx, ['/workspaces/:ws/docs/:docId/threads/:threadId/promote'], (v) =>
        handleDocPromoteRoute(ctx.docRoutesCtx, {
          ...scoped(v),
          refuseCategoryAuthor: v.refuseCategoryAuthor,
          metaFor: v.metaFor,
          withTaskChips: v.withTaskChips,
        }),
      ),
    // routes/dispatch-and-notes.ts, with routes/prompt-marks.ts and
    // routes/lead-mirror.ts inside it — dispatches, and the notes, prompt
    // marks and mirror under `agents/<agent>/` and `tasks/<id>/notes`.
    (app) =>
      claim(
        app,
        ctx,
        [
          '/workspaces/:ws/dispatches',
          '/workspaces/:ws/dispatches/*',
          '/workspaces/:ws/tasks/:taskId/notes',
          '/workspaces/:ws/agents/:agent/*',
        ],
        (v) =>
          handleDispatchAndNoteRoutes(ctx.taskRoutesCtx, {
            ...scoped(v),
            leadBoard: v.leadBoard,
            refuseCategoryAuthor: v.refuseCategoryAuthor,
          }),
      ),
    // routes/chat-audit-routes.ts — `chat-audit` and `chat-audit/<agent>`.
    (app) =>
      claim(app, ctx, ['/workspaces/:ws/chat-audit', '/workspaces/:ws/chat-audit/:agent'], (v) =>
        handleChatAuditRoutes(ctx.chatAuditRoutesCtx, {
          scope: v.scope,
          req: v.req,
          pathname: v.pathname,
          visitor: v.visitor,
        }),
      ),
    // The Library — routes/workspace-library.ts, its folders and its views,
    // every path under `library/`.
    (app) =>
      claim(app, ctx, ['/workspaces/:ws/library/*'], async (v) => {
        const rq = { scope: v.scope, req: v.req, visitor: v.visitor, authorFor: v.authorFor };
        return (
          (await handleLibraryRoutes(ctx.libraryRoutesCtx, rq)) ??
          (await handleLibraryFolderRoutes(ctx.libraryRoutesCtx, rq)) ??
          (await handleLibraryViewRoutes(ctx.libraryRoutesCtx, rq))
        );
      }),
    // routes/doc-move.ts — `docs/<id>/move`.
    (app) =>
      claim(app, ctx, ['/workspaces/:ws/docs/:docId/move'], (v) =>
        handleDocMoveRoute(ctx.docMoveRoutesCtx, {
          scope: v.scope,
          req: v.req,
          visitor: v.visitor,
        }),
      ),
    // routes/workspace-attachments.ts — agents, queues and acks; a composite.
    (app) =>
      claim(app, ctx, ANY_BOARD, (v) =>
        handleWorkspaceAttachmentRoutes(ctx.workspaceRoutesCtx, {
          ...scoped(v),
          leadBoard: v.leadBoard,
          boardAgent: v.boardAgent,
          accessEmail: v.accessEmail,
        }),
      ),
    // routes/archive.ts — `attachments`, `attachments/<id>…` and
    // `docs/<id>/(un)archive`.
    (app) =>
      claim(
        app,
        ctx,
        [
          '/workspaces/:ws/attachments',
          '/workspaces/:ws/attachments/*',
          '/workspaces/:ws/docs/:docId/archive',
          '/workspaces/:ws/docs/:docId/unarchive',
        ],
        (v) =>
          ctx.handleArchiveRoutes({
            req: v.req,
            pathname: v.pathname,
            url: v.url,
            visitor: v.visitor,
            scope: v.scope,
          }),
      ),
    // routes/workspace-delete.ts — `DELETE /workspaces/<id>`. Below the
    // archive family, as in the run.
    (app) =>
      claim(app, ctx, ['/workspaces/:ws'], (v) =>
        handleWorkspaceDeleteRoute(ctx.workspaceRoutesCtx, {
          ...scoped(v),
          accessEmail: v.accessEmail,
        }),
      ),
    // routes/review-files.ts — `attachments/<id>/<verb>`.
    (app) =>
      claim(app, ctx, ['/workspaces/:ws/attachments/:setId/*'], (v) =>
        handleReviewFileRoutes(ctx.reviewFileRoutesCtx, {
          scope: v.scope,
          req: v.req,
          url: v.url,
          pathname: v.pathname,
          visitor: v.visitor,
          metaFor: v.metaFor,
          withTaskChips: v.withTaskChips,
        }),
      ),
    // routes/meetings-calendar.ts — tried before the doc resource catch-all
    // below, which would otherwise swallow every `docs/<id>/meetings…`.
    (app) =>
      claim(
        app,
        ctx,
        [
          '/workspaces/:ws/docs/:docId/meetings',
          '/workspaces/:ws/docs/:docId/meetings/*',
          '/workspaces/:ws/docs/:docId/notes-method',
          '/workspaces/:ws/docs/:docId/meeting-bot',
          '/workspaces/:ws/calendar/events/:eventId/join',
          '/api/meeting-engines',
          '/api/calendar',
          '/api/calendar/*',
        ],
        (v) =>
          handleMeetingCalendarRoutes(ctx.meetingCalendarRoutesCtx, {
            scope: v.scope,
            req: v.req,
            url: v.url,
            pathname: v.pathname,
            visitor: v.visitor,
          }),
      ),
    // routes/docs.ts — one doc and its threads: `docs/<id>` and below it.
    (app) =>
      claim(app, ctx, ['/workspaces/:ws/docs/:docId', '/workspaces/:ws/docs/:docId/*'], (v) =>
        handleDocResourceRoutes(ctx.docRoutesCtx, {
          ...scoped(v),
          leadBoard: v.leadBoard,
          boardAgent: v.gate.boardAgent,
          answerProof: v.answerProof,
          refuseCategoryAuthor: v.refuseCategoryAuthor,
          metaFor: v.metaFor,
          withTaskChips: v.withTaskChips,
          provenIdentityFor: v.provenIdentityFor,
          requestOriginFor: v.requestOriginFor,
        }),
      ),
  ];
}
