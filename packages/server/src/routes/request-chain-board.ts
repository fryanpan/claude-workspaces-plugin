/**
 * ── The request chain, second third: the board and REST families ──
 *
 * Everything below the workspace scope and above the top-level families,
 * moved whole and in order out of `createServer`'s `route()` — see
 * `request-chain.ts` for the gates above it and why the order is behaviour.
 * The one load-bearing position in this run is the meetings: every
 * `/api/docs/<id>/meetings...` pattern is tried before the doc catch-all at
 * the bottom, which would otherwise swallow them all.
 *
 * `null` means no family here claimed the address, and the chain goes on to
 * `request-chain-tail.ts`.
 */
import { handleAgentIdentityRoutes } from './agent-identity.ts';
import { handleAppRoutes } from './apps.ts';
import { handleBoardSocketRootsRoutes } from './board-socket-roots.ts';
import { handleBoardTokenRoutes } from './board-tokens.ts';
import { handleChatAuditRoutes } from './chat-audit-routes.ts';
import { handleDocMoveRoute } from './doc-move.ts';
import {
  handleDocCreateListRoutes,
  handleDocPromoteRoute,
  handleDocResourceRoutes,
} from './docs.ts';
import { handleLoadReportRoutes } from './load-reports.ts';
import { handleMcpConnectorRoute } from './mcp-connector.ts';
import { handleMeetingCalendarRoutes } from './meetings-calendar.ts';
import { handleMountRoutes } from './mounts.ts';
import { handleOpsMetricsRoute, handleOpsRoutes, handleSummaryBackfillRoute } from './ops.ts';
import { handleRepoRoutes } from './repos.ts';
import type { ChainRequest, RequestChainContext } from './request-chain-context.ts';
import { handleReviewFileRoutes } from './review-files.ts';
import { handleDispatchAndNoteRoutes, handleTaskRoutes } from './tasks.ts';
import { handleWhiteboardCreateRoute } from './whiteboard-routes.ts';
import { handleLibraryRoutes } from './workspace-library.ts';
import {
  handleWorkspaceAttachmentRoutes,
  handleWorkspaceDeleteRoute,
  handleWorkspaceGoalRoutes,
  handleWorkspaceRoutes,
} from './workspaces.ts';

export async function serveBoardRoutes(
  ctx: RequestChainContext,
  rq: ChainRequest,
): Promise<Response | null> {
  const {
    opsRoutesCtx,
    docRoutesCtx,
    appRoutesCtx,
    workspaceRoutesCtx,
    taskRoutesCtx,
    policyFor,
    connectorHost,
    boardOfSocket,
    j,
    requestAddress,
    agentTokenKeyFor,
    agentIdentityRoutesCtx,
    boardTokenRoutesCtx,
    boardSocketRootsRoutesCtx,
    chatAuditRoutesCtx,
    repoRoutesCtx,
    loadReportRoutesCtx,
    mountRoutesCtx,
    libraryRoutesCtx,
    docMoveRoutesCtx,
    handleArchiveRoutes,
    reviewFileRoutesCtx,
    meetingCalendarRoutesCtx,
  } = ctx;
  const { req, url, pathname, scope, gate, attribution } = rq;
  const { visitor, boardAgent, leadBoard, metaFor, roleFor, requireOwner } = gate;
  const { authorFor, refuseCategoryAuthor, withTaskChips, provenIdentityFor } = attribution;
  /** What this request proved about a person, for the answer doors. */
  const answerProof = {
    req,
    provenIdentityFor,
    widgetIdentity: attribution.widgetIdentity,
    requestOrigin: () => policyFor(req).requestOrigin,
  };

  // --- REST: run the summary backfill on request --- see
  // ./routes/ops.ts. Same chain position as before the split: above the
  // metrics route, which is the next call below.
  {
    const handled = await handleSummaryBackfillRoute(opsRoutesCtx, {
      req,
      pathname,
      visitor,
      authorFor,
    });
    if (handled) return handled;
  }

  // --- REST: what this process currently costs ---
  //
  // The 2026-08-29 jetsam kill left nothing to read: the server was at
  // 2.6 GB and the only evidence of how it got there was the absence of
  // the process. `DocStore.stats()` is also written to the log every five
  // minutes; this route is the same numbers on demand, so the NEXT
  // incident can be sampled over time instead of reconstructed.
  //
  // Counts only — no doc ids, no paths, no titles. That is what makes
  // it safe to leave un-gated for anyone already past the front door,
  // and it still refuses a share visitor: an external reviewer invited
  // to one document has no business reading how many others exist.
  {
    const handled = handleOpsMetricsRoute(opsRoutesCtx, {
      req,
      pathname,
      visitor,
      authorFor,
    });
    if (handled) return handled;
  }

  // --- REST: docs, created and listed — ./routes/docs.ts ---
  // A whiteboard is created beside them (./routes/whiteboard-routes.ts):
  // `whiteboards` is an exact remainder no other route here answers.
  {
    const docRq = {
      scope,
      req,
      url,
      pathname,
      visitor,
      authorFor,
      refuseCategoryAuthor,
      roleFor,
      requireOwner,
      metaFor,
      withTaskChips,
    };
    const handled =
      (await handleDocCreateListRoutes(docRoutesCtx, docRq)) ??
      (await handleWhiteboardCreateRoute(docRoutesCtx, docRq));
    if (handled) return handled;
  }

  // --- An attached dev server — ./routes/apps.ts ---
  // Its attach sits beside the doc create it mirrors, and its reads claim
  // only `apps/<id>/…`, which no route below answers.
  {
    const handled = await handleAppRoutes(appRoutesCtx, {
      req,
      url,
      scope,
      visitor: Boolean(visitor),
      mayMintAppVoice: rq.mayMintAppVoice(),
    });
    if (handled) return handled;
  }

  // --- REST: workspaces (the board's own routes) — ./routes/ ---
  // A board is created here, read here, and every field on it is
  // written here: its Home queue, its next-work answer, its settings,
  // its lead, and the docs and huddles filed onto it. They run HERE, in
  // the position they were written in: the chain's order is behaviour,
  // and `routes/workspaces.ts` keeps it.
  {
    const handled = await handleWorkspaceRoutes(workspaceRoutesCtx, {
      scope,
      req,
      pathname,
      url,
      visitor,
      authorFor,
      accessEmail: gate.accessEmail,
      roleFor,
      requireOwner,
      provenIdentityFor,
      requestOriginFor: () => policyFor(req).requestOrigin,
      answerProof,
    });
    if (handled) return handled;
  }

  // --- REST: tasks (plan §3.10) — ./routes/ ---
  // Every handler over there hand-copies body fields into the store
  // call. A field that isn't copied is silently discarded while the
  // request still returns 200 — so every param has an HTTP-level test
  // in task-routes.test.ts (the `groups` lesson). They run HERE, in the
  // position they were written in: the chain's order is behaviour, and
  // `routes/tasks.ts` keeps it.
  {
    const handled = await handleTaskRoutes(taskRoutesCtx, {
      scope,
      req,
      pathname,
      url,
      visitor,
      authorFor,
      refuseCategoryAuthor,
      roleFor,
      requireOwner,
      provenIdentityFor,
      requestOriginFor: () => policyFor(req).requestOrigin,
      answerProof,
    });
    if (handled) return handled;
  }
  // --- REST: goal bands and the ordered goal list --- see
  // ./routes/workspace-goals.ts. Same chain position as before the
  // split: below the task routes, above the thread promote.
  {
    const handled = await handleWorkspaceGoalRoutes(workspaceRoutesCtx, {
      scope,
      req,
      pathname,
      url,
      visitor,
      authorFor,
      accessEmail: gate.accessEmail,
      roleFor,
      requireOwner,
    });
    if (handled) return handled;
  }
  // --- REST: promote a thread to a task — ./routes/docs.ts ---
  {
    const handled = await handleDocPromoteRoute(docRoutesCtx, {
      scope,
      req,
      url,
      pathname,
      visitor,
      authorFor,
      refuseCategoryAuthor,
      roleFor,
      requireOwner,
      metaFor,
      withTaskChips,
    });
    if (handled) return handled;
  }
  // --- MCP: the hosted connector, loopback agents only --- see
  // ./routes/mcp-connector.ts. One exact path nothing else answers, so
  // its position shadows nothing; it sits beside the agent-id routes
  // because it is the door those agents come through.
  {
    const handled = await handleMcpConnectorRoute(
      {
        host: connectorHost,
        j,
        requestAddress,
        agentTokenKey: agentTokenKeyFor,
        boardOfSocket,
      },
      { req, pathname, visitor },
    );
    if (handled) return handled;
  }
  // --- REST: durable agent watches, and the agent merge --- see
  // ./routes/agent-identity.ts. Same chain position as before the
  // split: after the promote route, before the builder dispatches.
  {
    const handled = await handleAgentIdentityRoutes(agentIdentityRoutesCtx, {
      req,
      pathname,
      visitor,
      authorFor,
      boardAgent,
    });
    if (handled) return handled;
  }
  // --- REST: board agent tokens --- see ./routes/board-tokens.ts. One
  // exact family of paths, so its position changes nothing.
  {
    const handled = await handleBoardTokenRoutes(boardTokenRoutesCtx, {
      req,
      pathname,
      visitor,
      boardAgent,
    });
    if (handled) return handled;
  }
  // --- REST: the folders a board's walled lead can write --- see
  // ./routes/board-socket-roots.ts. One exact family of paths.
  {
    const handled = await handleBoardSocketRootsRoutes(boardSocketRootsRoutesCtx, {
      req,
      pathname,
      visitor,
    });
    if (handled) return handled;
  }
  // --- REST: builder dispatches, and a session's notes on the row it
  // holds --- see ./routes/dispatch-and-notes.ts. Same chain position
  // as before the split: after the agent merge route, before chat-audit.
  {
    const handled = await handleDispatchAndNoteRoutes(taskRoutesCtx, {
      scope,
      req,
      pathname,
      url,
      visitor,
      leadBoard,
      authorFor,
      refuseCategoryAuthor,
      roleFor,
      requireOwner,
    });
    if (handled) return handled;
  }
  // --- REST: chat-audit counters --- see ./routes/chat-audit-routes.ts.
  // Same chain position as before the split: after the builder
  // dispatches, before the operator routes.
  {
    const handled = await handleChatAuditRoutes(chatAuditRoutesCtx, {
      scope,
      req,
      pathname,
      visitor,
    });
    if (handled) return handled;
  }
  // --- Operator routes: plugin refresh, push and deploy — ./routes/ops.ts ---
  // Same chain position as before the split: after the chat-audit
  // routes, before the agent attachments.
  {
    const handled = await handleOpsRoutes(opsRoutesCtx, {
      req,
      pathname,
      visitor,
      authorFor,
    });
    if (handled) return handled;
  }
  // --- The repo registry: checkouts, and which copy is live ---
  // ./routes/repos.ts. Placed beside the operator routes because it
  // shares their gate: loopback only, no edge, no visitor. Order is not
  // load-bearing — no other family claims `/api/repos`.
  {
    const handled = await handleRepoRoutes(repoRoutesCtx, {
      req,
      pathname,
      url,
      visitor,
    });
    if (handled) return handled;
  }
  // --- Load reports from pages on no board, and the slowest-load read ---
  // ./routes/load-reports.ts. Order is not load-bearing: no other family
  // claims `/api/load-reports`.
  {
    const handled = await handleLoadReportRoutes(loadReportRoutesCtx, { req, pathname, visitor });
    if (handled) return handled;
  }
  // --- Mounted project folders: the mount table, and a file's address ---
  // ./routes/mounts.ts. Two gates in one family — `/api/mounts` shares the
  // loopback-only gate above, and `/mounts/<fileId>` is the member-facing
  // address. Order is not load-bearing: no other family claims either
  // prefix.
  {
    const handled = await handleMountRoutes(mountRoutesCtx, {
      req,
      pathname,
      url,
      visitor,
    });
    if (handled) return handled;
  }
  // --- The board's Library --- ./routes/workspace-library.ts. Both of its
  // paths sit under `library/`, which no other family claims, so the
  // position is not load-bearing.
  {
    const handled = await handleLibraryRoutes(libraryRoutesCtx, { scope, req, visitor });
    if (handled) return handled;
  }
  // --- Moving a doc into its project --- ./routes/doc-move.ts. Its one
  // path, `docs/<id>/move`, is a subroute the doc resource block below
  // does not answer, so the position is not load-bearing.
  {
    const handled = await handleDocMoveRoute(docMoveRoutesCtx, { scope, req, visitor });
    if (handled) return handled;
  }
  // --- REST: agent attachments (§4) --- see
  // ./routes/workspace-attachments.ts. Same chain position as before
  // the split: after the deploy routes, before the archive pair.
  {
    const handled = await handleWorkspaceAttachmentRoutes(workspaceRoutesCtx, {
      scope,
      req,
      pathname,
      url,
      visitor,
      authorFor,
      accessEmail: gate.accessEmail,
      roleFor,
      requireOwner,
    });
    if (handled) return handled;
  }
  // --- REST: archive and unarchive, for a review and for one doc ---
  // see ./routes/archive.ts. Same chain position as before the split:
  // after the agent attachments, before the board delete.
  {
    const handled = await handleArchiveRoutes({ req, pathname, url, visitor, scope });
    if (handled) return handled;
  }
  // --- REST: the board delete --- see ./routes/workspace-delete.ts.
  // It stays BELOW the archive family, which serves `DELETE
  // /workspaces/<ws>/attachments/<setId>`. The order used to be load-bearing
  // because one path meant either store; now the two verbs have two
  // addresses and cannot be confused, and the order is kept because
  // nothing is gained by moving it.
  {
    const handled = await handleWorkspaceDeleteRoute(workspaceRoutesCtx, {
      scope,
      req,
      pathname,
      url,
      visitor,
      authorFor,
      accessEmail: gate.accessEmail,
      roleFor,
      requireOwner,
    });
    if (handled) return handled;
  }
  // --- REST: a review's own files --- see ./routes/review-files.ts.
  // Same chain position as before the split: after the board delete,
  // before the meeting and calendar routes.
  {
    const handled = await handleReviewFileRoutes(reviewFileRoutesCtx, {
      scope,
      req,
      url,
      pathname,
      visitor,
      metaFor,
      withTaskChips,
    });
    if (handled) return handled;
  }
  // --- Meetings, transcripts and the calendar — ./routes/meetings-calendar.ts ---
  // Called from the position the block occupied: every
  // `/api/docs/<id>/meetings...` pattern has to be tried before the
  // doc catch-all below, which would otherwise swallow all of them.
  {
    const handled = await handleMeetingCalendarRoutes(meetingCalendarRoutesCtx, {
      scope,
      req,
      url,
      pathname,
      visitor,
    });
    if (handled) return handled;
  }
  // --- REST: one doc and its threads — ./routes/docs.ts ---
  {
    const handled = await handleDocResourceRoutes(docRoutesCtx, {
      scope,
      req,
      url,
      pathname,
      visitor,
      boardAgent: gate.boardAgent,
      answerProof,
      authorFor,
      refuseCategoryAuthor,
      roleFor,
      requireOwner,
      metaFor,
      withTaskChips,
    });
    if (handled) return handled;
  }
  return null;
}
