import { join } from 'node:path';
import {
  type DocType,
  type Thread,
  type User,
  type WebhookPayload,
  agentIdForName,
  attachmentIdOf,
  contentKind,
  isReviewPayloadGated,
  parseThreadReviewItemId,
  pendingDeclaration,
} from '@claude-workspaces/core';
import { createAccessDeps } from './access-deps.ts';
import { releaseActivityLock } from './activity-lock.ts';
import { commentTrustOf, ownerDisplayNames, ownerIdentityIds } from './actor-identity.ts';
import { AgentNoteLog } from './agent-note-log.ts';
import { AgentNoteRing } from './agent-notes.ts';
import { AgentWatches } from './agent-watches.ts';
import { AllowRuleProposals } from './allow-rules.ts';
import { AppOutages } from './app-outage.ts';
import { appVoiceLimitsFromEnv } from './app-voice/limits.ts';
import { AppVoiceRelay } from './app-voice/relay.ts';
import { appSayer } from './app-voice/say.ts';
import { appVoiceSocketPath } from './app-voice/seed.ts';
import { appVoiceTokenKey, checkAppVoiceToken, mintAppVoiceToken } from './app-voice/token.ts';
import { ARTIFACT_CHECK_ACTOR, ArtifactChecker } from './artifact-check.ts';
import { localOnlyPlacesFrom, offBoxAskView } from './ask-feed.ts';
import { type AttachMountsBrief, attachMountsBrief } from './attach-mounts.ts';
import { backfillAttachmentFiling } from './attachment-backfill.ts';
import { AttachmentPrivacyStore, isOnBox } from './attachment-privacy.ts';
import { identifyCallerAgent } from './auth/agent-caller.ts';
import {
  authorizeAgentCaller,
  createLegacyAgentWarner,
  createRefusedMintWarner,
  agentTokenKey as deriveAgentTokenKey,
  mintAgentToken,
  refuseNonLocalAgentCaller,
  verifyAgentToken,
} from './auth/agent-token.ts';
import { BoardAgentTokens, boardAgentTokenKey, boardTokensPath } from './auth/board-agent-token.ts';
import { githubPushKeyKey } from './auth/github-push-key.ts';
import { lastBoardActivityAt } from './board-activity.ts';
import { DEFAULT_BOARD_WORKSPACE_NAME, createBoardMembership } from './board-membership.ts';
import { BoardSocketRoots, boardSocketRootsPath } from './board-socket-roots.ts';
import { openBoardSockets } from './board-sockets.ts';
import { createBoardSummaries } from './board-summary.ts';
import { type BrowserSentryConfig } from './browser-sentry.ts';
import { ChatAudit } from './chat-audit.ts';
import { planBoardReading } from './coach/week-plan.ts';
import { wireCoach } from './coach/wiring.ts';
import { type CommentTrustFor, createCommentTrust } from './comment-trust.ts';
import { boardTokenLease } from './connector/board-token-lease.ts';
import { type ConnectorHost, createConnectorHost } from './connector/host.ts';
import { hostedSessionFactory } from './connector/session-factory.ts';
import { loadConnectorSnapshot, saveConnectorSnapshot } from './connector/snapshot.ts';
import { createCrossReview } from './cross-review.ts';
import { DispatchRegistry } from './dispatch-registry.ts';
import { DispatchReportStore } from './dispatch-reports.ts';
import { DocStore } from './doc-store.ts';
import { createEffortScoring } from './effort-scoring.ts';
import { InflightRegistry, LoopLagMonitor } from './event-loop.ts';
import { originOfHeaders, withEventOrigin } from './event-origin.ts';
import { type FolderWatches, createFolderWatches, liveSourceOf } from './folder-watch.ts';
import { createFrameHost } from './frame-host.ts';
import { frameKeys } from './frame-ticket.ts';
import { personProofOf, refuseStaleSignIn } from './fresh-signin.ts';
import { GithubHub, githubHubPath } from './github-hub.ts';
import { taskDeepLink } from './home-brief.ts';
import { homeFeedOf } from './home-feed.ts';
import { createHomePane } from './home-pane.ts';
import { createHomeRemotes } from './home-remotes.ts';
import { Identities } from './identities.ts';
import { createIdentitySetup } from './identity-setup.ts';
import { LANDING_CHANGED_EVENT, LANDING_CHANNEL, createLandingChanges } from './landing-changes.ts';
import { renderRemoteReview } from './landing-remote.ts';
import { LeadChat } from './lead-chat/lead-chat.ts';
import { LeadChatLog } from './lead-chat/log.ts';
import { LeadChatMeetings } from './lead-chat/meeting.ts';
import { LeadSessionMirror } from './lead-chat/mirror.ts';
import { wireLeadRanks } from './lead-rank-wiring.ts';
import { createMarkdownLister, projectRepoKey } from './library.ts';
import { describeLiveness } from './liveness.ts';
import { type LookupDoc, boardLookupDocs } from './meeting-lookup.ts';
import { retitleClockTitlesAtBoot } from './meeting-titler.ts';
import { wireMeetings } from './meeting-wiring.ts';
import { isLoopbackAddress } from './middleware/host-guard.ts';
import { loopbackUidDoor } from './middleware/loopback-uid-door.ts';
import { isBrowserRequest } from './middleware/write-gate.ts';
import { boardLinkedItems } from './mockup-linked-items.ts';
import { MountStore } from './mount-store.ts';
import { parseMuxCursor } from './mux-cursor.ts';
import { rollupNotesQuality } from './notes-quality-store.ts';
import { NOTES_QUALITY_WINDOW_MS } from './notes-quality-thresholds.ts';
import { PageLoadLog } from './page-loads.ts';
import {
  ACCESS_CHANNEL,
  PROMPTS_CHANNEL,
  VOICE_CHANNEL,
  createPageNudger,
  wirePageNudges,
} from './page-nudges.ts';
import {
  PARK_MIGRATION_ACTOR,
  type ParkMigrationResult,
  migrateParkedRows,
} from './park-migration.ts';
import { parkNoteText } from './park-note.ts';
import { PermissionGrants, wirePermissionGrantRelease } from './permission-grants.ts';
import { readReleasedPluginVersion } from './plugin-release.ts';
import { createPromptStore } from './prompt-store.ts';
import { publicBaseUrl, tailnetHostname } from './public-host.ts';
import { createPushAnnounce } from './push-announce.ts';
import type { NudgeTally } from './ready-nudge.ts';
import { scanSettledDocRefs } from './refs-backfill.ts';
import { createOriginPolicy, createRequestAdmission } from './request-admission.ts';
import { createRequestAttribution } from './request-attribution.ts';
import { BLOCKING_WAIT_WINDOW_MS, blockingWait } from './review-answer-ledger.ts';
import {
  listArchivedReviews,
  readArchiveManifest,
  readDocArchiveManifest,
} from './review-archive.ts';
import { createReviewGate } from './review-gate.ts';
import { isAnalyticsOnlyEvent } from './review-items/analytics.ts';
import { gateOwnerItems } from './review-items/done-when-owner.ts';
import type { ReviewThreadItem } from './review-queue.ts';
import { ReviewSizePrefs } from './review-size-prefs.ts';
import type { SizedReviewItemRow } from './review-sizing.ts';
import { createStaleAskNotifier } from './review-stale-notify.ts';
import { type AccessRoutesContext } from './routes/access.ts';
import { type AgentIdentityRoutesContext } from './routes/agent-identity.ts';
import { type AppRoutesContext } from './routes/apps.ts';
import { type ArchiveRoutesContext, createArchiveRoutes } from './routes/archive.ts';
import { type AuthShareRoutesContext } from './routes/auth-share.ts';
import { type BoardSocketRootsRoutesContext } from './routes/board-socket-roots.ts';
import { type BoardTokenRoutesContext } from './routes/board-tokens.ts';
import { type ChatAuditRoutesContext } from './routes/chat-audit-routes.ts';
import { type CoachRoutesContext } from './routes/coach.ts';
import { type DocMoveRoutesContext } from './routes/doc-move.ts';
import type { DocRoutesContext } from './routes/docs-routes-context.ts';
import { startServerFeatures } from './routes/features.ts';
import { type GithubHubRoutesContext } from './routes/github-hub.ts';
import { type HomeFeedRoutesContext } from './routes/home-feed.ts';
import { type LoadReportRoutesContext } from './routes/load-reports.ts';
import { type MeetingCalendarRoutesContext } from './routes/meetings-calendar.ts';
import { type MountRoutesContext } from './routes/mounts.ts';
import { type OpsRoutesContext } from './routes/ops.ts';
import { type PromptRoutesContext } from './routes/prompts.ts';
import { type RecallWebhookRoutesContext } from './routes/recall-webhook.ts';
import { type RepoRoutesContext } from './routes/repos.ts';
import { createRequestChain } from './routes/request-chain.ts';
import { type ReviewFileRoutesContext } from './routes/review-files.ts';
import { type ReviewQueueRoutesContext } from './routes/review-queue.ts';
import { ROUTE_TABLE } from './routes/route-table-rows.ts';
import { mountRouteTable } from './routes/route-table.ts';
import { applyMasterFlip } from './routes/share-switch.ts';
import { createShellStatic } from './routes/shell-static.ts';
import { type TaskRoutesContext } from './routes/tasks.ts';
import { createUpgradeStream } from './routes/upgrade-stream.ts';
import { type VoiceAgentLlmRoutesContext } from './routes/voice-agent-llm.ts';
import { type VoiceApiRoutesContext } from './routes/voice-api.ts';
import { type VoicePageRoutesContext } from './routes/voice-page.ts';
import { type LibraryRoutesContext, libraryRunOutputSource } from './routes/workspace-library.ts';
import { type MeetingHomeResolution, type WorkspaceRoutesContext } from './routes/workspaces.ts';
import { captureServerError } from './sentry.ts';
import type { ServerOptions } from './server-options.ts';
import { AccessProposals } from './share/access-proposals.ts';
import { buildAccessView } from './share/access-view.ts';
import { collabMembershipEnded } from './share/collab-member-key.ts';
import type { ShareLinks } from './share/share-links.ts';
import { Shares } from './share/shares.ts';
import { SharingGate } from './share/sharing-gate.ts';
import { SHARING_NOTICE_ACTOR, SharingNotice, rankFallbackBoards } from './sharing-notice.ts';
import { sharingOffCardPath, sharingOffDoorAllows } from './sharing-off-door.ts';
import { boundFiles } from './slow-fs.ts';
import { SlowLoadAlarm } from './slow-load-alarm.ts';
import { type UpgradeData, createSocketHandlers } from './socket-handlers.ts';
import { agentLine } from './spoken-reply/agent-conversation.ts';
import { AgentCallbacks } from './spoken-reply/agent-llm.ts';
import type { SpokenBoard } from './spoken-reply/answer.ts';
import { interviewDocs, voicePointer } from './spoken-reply/interview-docs.ts';
import { INTERVIEW_TIMINGS_FILE, InterviewLog } from './spoken-reply/interview-log.ts';
import { PlanMinutes } from './spoken-reply/plan-minutes.ts';
import { SpokenReplyRelay } from './spoken-reply/relay.ts';
import { SPOKEN_TIMINGS_FILE, SpokenTimings } from './spoken-reply/timings.ts';
import { claimReplayMarks, saveReplayMarks } from './sse-marks.ts';
import { channelForWatchKey, openAgentMuxStream } from './sse-mux.ts';
import { HTTP_IDLE_TIMEOUT_SEC, SseBus, openSseStream } from './sse.ts';
import { createStallWiring } from './stall-wiring.ts';
import { cryptoId } from './task-fields.ts';
import { isReservedGoalId } from './task-goals.ts';
import { TaskProjection, taskBodyDocId, workspaceDocId } from './task-projection.ts';
import {
  type RunOutputSource,
  itemsLinking,
  noteOutputOpened,
  observeRunOutput,
} from './task-run-output.ts';
import { DEFAULT_SPAWNER_AGENT_ID, observeScheduledWake } from './task-scheduled-wake.ts';
import { type FiredOccurrence, SCHEDULER_ACTOR, createTaskScheduler } from './task-scheduler.ts';
import {
  DEFAULT_PARALLELISM_CAP,
  type ParallelismCapChange,
  type Task,
  TaskStore,
} from './tasks.ts';
import { ThreadOpenerProofs, threadOpenerProofsPath } from './thread-opener-proofs.ts';
import { ThreadRequestDedup } from './thread-request-dedup.ts';
import { UptimeMonitor } from './uptime.ts';
import { voiceAgentList } from './voice-agent-list.ts';
import { workspacesVoiceAgents } from './voice-api/backend.ts';
import { VoiceChat } from './voice-api/chat.ts';
import { VoiceApiTokens, voiceApiTokenKey, voiceTokensPath } from './voice-api/tokens.ts';
import { routerClassifier } from './voice-choice.ts';
import { meetingContext } from './voice-meeting-context.ts';
import { VoiceRouter, parseVoiceContext } from './voice.ts';
import { type WebhookLogEntry, createWebhookDispatcher } from './webhooks.ts';
import { isRetired } from './workspace-store.ts';

const DEFAULT_PORT = Number(process.env.PORT ?? 8787);

/** Attribution for a write that arrived with no author at all. Deliberately
 *  NOT Bryan: an unattributed action must never gain his authority just
 *  because a field was missing. */

const ANONYMOUS_ACTOR: User = {
  id: 'anon-unattributed',
  name: 'Anonymous',
  kind: 'anon',
  color: '#8a8a8a',
};

import { createAgentSpots } from './agent-spots.ts';
import { BOARD_FEEDBACK_DOC_ID } from './doc-ids.ts';
import {
  HTML_SHELL_HEADERS,
  appCacheControl,
  boardLastActivity,
  readAppAssetManifest,
  renderAccessShell,
  renderBoardShell,
  renderReviewsShell,
  renderSigninShell,
  renderVoiceShell,
  serveStaticUnder,
} from './shells.ts';
import { taskIdOfBodyDoc } from './task-row.ts';

/**
 * Re-exported: these were declared in this file until the HTML shells moved
 * to `shells.ts`, and the tests and `bin.ts` address them here. The
 * definitions live there now; this keeps the public surface where callers
 * already point.
 */
export {
  HTML_SHELL_HEADERS,
  BOARD_FEEDBACK_DOC_ID,
  appCacheControl,
  readAppAssetManifest,
  renderBoardShell,
  renderSigninShell,
  serveStaticUnder,
};

export type { ServerOptions };

/**
 * `revisedRange` off a request body: the offsets into the NEW detail that a
 * caller says changed.
 *
 * One parser for both revise routes — the ticket one and the doc-thread one.
 * It was inline in the ticket route when it was the only one; copying it
 * would have been two places free to disagree about what a legal span is,
 * which is the drift this file has been bitten by before. An absent range is
 * legal and means "derive it".
 */
function parseRevisedRange(
  raw: unknown,
): { ok: true; range?: { start: number; end: number } } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  const r = raw as { start?: unknown; end?: unknown } | null;
  const start = r?.start;
  const end = r?.end;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start
  ) {
    return { ok: false, error: 'revisedRange must be {start, end} offsets with start <= end' };
  }
  return { ok: true, range: { start, end } };
}

export interface ServerHandle {
  port: number;
  /** The app voice socket's tokens (`app-voice/token.ts`). Exposed so a test
   *  can mint one at a chosen time — an expired one, or one for another doc. */
  appVoice: {
    mint(workspaceId: string, docId: string, at?: number): { token: string; expiresAt: number };
  };
  docStore: DocStore;
  /** The board task store — workspaces, tasks, the transition gate. */
  tasks: TaskStore;
  /** The ydoc projection of the task store (ws:<id> board docs + task
   *  body docs). Exposed so tests can force a reassert. */
  projection: TaskProjection;
  /** Per-agent durable watch sets (agent-watches.ts). Exposed so tests can
   *  read the store the route wrote, not only the route's answer. */
  agentWatches: AgentWatches;
  /** The hosted MCP connector behind `/mcp` (connector/host.ts). Exposed so
   *  tests can read its tables and run its sweep. */
  connector: ConnectorHost;
  /** The chat-audit log — the daily audit's published counts AND the rows the
   *  Stop-hook note route writes live. Exposed for the same reason
   *  `agentWatches` is: the count a board shows is a store read, and a test
   *  that re-implemented the window would not be testing the window. */
  chatAudit: ChatAudit;
  /** The fleet address book (identities.ts) — people and agents. Exposed
   *  for the same reason `agentWatches` is. */
  identities: Identities;
  /** Open builder dispatches and their worktree watchers
   *  (dispatch-registry.ts). Exposed for the same reason `agentWatches` is. */
  dispatches: DispatchRegistry;
  /** The builders' closing reports (dispatch-reports.ts). Exposed for the same
   *  reason `dispatches` is. */
  dispatchReports: DispatchReportStore;
  /** The folders open pages are watching (folder-watch.ts). Exposed so a
   *  test can count them after the last page leaves. */
  folderWatches: FolderWatches;
  shares: Shares | null;
  /** The share-link store: links, members and each board's audience.
   *  Exposed so a test can name who a board admits without a person's
   *  browser, which is the only other door that may (`board-audience.ts`). */
  shareLinks: ShareLinks;
  /** Hang up every websocket and SSE stream whose share is no longer live,
   *  and every widget door socket whose board token is dead. Runs on a 60s
   *  interval; exposed so tests exercise the real sweep. */
  sweepDeadShares: () => void;
  /**
   * The startup pass that moves rows off the removed `parked` state onto
   * triage plus a comment (park-migration.ts).
   *
   * A promise rather than a function, because it is fired once at start and
   * the handle's job is to let a caller AWAIT it. Without that a test — or a
   * boot-time reader — races a write that is already in flight, and the flake
   * would look like a migration that sometimes does not run.
   */
  parkMigration: Promise<ParkMigrationResult>;
  /** One pass of the ready-work wake (ready-nudge.ts). Runs on a 60s
   *  interval; exposed so tests exercise the real pass. */
  nudgeReadyWork: () => void;
  /** One pass of the stall wake (stall-nudge.ts). Runs on a 60s interval;
   *  exposed so tests exercise the real pass. */
  nudgeStalls: () => void;
  /** The same pass as the timer runs it: the cold docs it reads are loaded
   *  first, in slices, then the pass itself. */
  nudgeStallsTimed: () => Promise<void>;
  /** One pass of the scheduled-task loop (task-scheduler.ts), returning the
   *  occurrences it fired. Runs on a 30s interval; exposed for the same
   *  reason the two wakes are — a test drives the real pass. */
  runScheduler: () => FiredOccurrence[];
  /**
   * The wake's own falsifiability counter — what it suppressed, by condition,
   * against what it actually delivered.
   *
   * Exposed on the handle so the number has a destination besides the stamp
   * file it is persisted in. It does not need a reader to be USEFUL, which is
   * the design: the verdict fires itself through the nudger's reporter when
   * the seven-day window closes. See `NUDGE_TALLY_WINDOW_MS` in
   * ready-nudge.ts for the stopping rule and who acts on it.
   */
  readyNudgeTally: () => NudgeTally;
  /** The external-access master switch — read/flip it without HTTP. */
  sharingGate: SharingGate;
  webhookLog: WebhookLogEntry[];
  stop: () => Promise<void>;
}

export function createServer(opts: ServerOptions = {}): ServerHandle {
  const port = opts.port ?? DEFAULT_PORT;
  // `CW_TEST_BIND_HOST` is set by `test/loopback-bind.preload.ts` for every
  // `bun test` run and by nothing else; see `ServerOptions.hostname`.
  const hostname = opts.hostname ?? process.env.CW_TEST_BIND_HOST;
  const dataDir = opts.dataDir ?? join(process.cwd(), 'data');
  // The words every prompt on this server runs on. `bin.ts` hands its own
  // store down so one instance serves the routes, the notes composer and the
  // classifiers; a server spun up without one builds its own, because reading
  // a file beside the data dir is not the kind of dependency the seam rule is
  // about (see ServerOptions.promptStore).
  const promptStore = opts.promptStore ?? createPromptStore({ dataDir });
  const slowRequestMs = opts.slowRequestMs ?? 500;
  const clientReleaseRootDir = opts.clientReleaseRootDir ?? null;
  const widgetDist = opts.widgetDistDir ?? null;
  const markdownAppDist = opts.markdownAppDistDir ?? null;
  /**
   * Browser Sentry config for every shell this server renders or rewrites.
   * `null` — not an empty DSN — when unconfigured, which is what makes the
   * "no DSN, no tags, no script, no SDK, no outbound request" chain start
   * from one check rather than five. See browser-sentry.ts.
   */
  const browserSentry: BrowserSentryConfig | null = opts.sentryDsn
    ? {
        dsn: opts.sentryDsn,
        release: opts.sentryRelease ?? null,
        environment: opts.sentryEnvironment ?? null,
      }
    : null;
  const demosDir = opts.demosDir ?? null;

  // Who may reach this server, over which hostname: the sharing registry,
  // the share-link store, the master switch and the three Access verifiers,
  // built from the settings `server-config.ts` resolved. See server-deps.ts —
  // `createServer` composes them, it does not derive them.
  const {
    shares,
    shareLinks,
    shareLinkHosts,
    shareLinkBaseHost,
    shareLinkVerifier,
    sharingGate,
    cookieKey,
    boardShareTarget,
    cfAccessVerifier,
    staticAccessVerifier,
    accessTunnelHosts,
    collabAccessVerifier,
    proxiedTrustedEmails,
    proxiedTrustedVerifier,
    proxiedTrustedHosts,
    recallCallbackHost,
  } = createAccessDeps({
    dataDir,
    opts,
    // Forward reference on purpose: the task store is built below, and
    // `boardShareTarget` is only ever asked at request time.
    isBoard: (workspaceId) => taskStore.getWorkspace(workspaceId) !== undefined,
  });
  /** Anyone besides the owner can reach the board: a share link, a member
   *  who redeemed one, or a share. Read by the sharing notice. */
  const boardIsShared = (workspaceId: string): boolean =>
    (shareLinks?.forWorkspace(workspaceId).length ?? 0) > 0 ||
    (shareLinks?.membersOf(workspaceId).length ?? 0) > 0 ||
    (shares?.list() ?? []).some((sh) => sh.workspaceId === workspaceId);

  const sse = new SseBus();
  // Pick up where the last clean shutdown left off, so a deploy is silent on
  // every channel nothing happened on. Discarded automatically if that process
  // died instead of stopping — see sse-marks.ts for why that direction is the
  // safe one.
  sse.restoreMarks(claimReplayMarks(dataDir));
  // Open `/` and `/review` pages hear one frame per burst, naming the parts
  // of `/` that changed.
  const landingChanges = createLandingChanges({
    emit: (parts) => {
      const frame = { event: LANDING_CHANGED_EVENT, parts };
      sse.broadcastTransient(LANDING_CHANNEL, frame);
    },
  });
  sse.tap(landingChanges.observe);
  // Home across servers: pulled from each other server, never pushed here
  // (home-remotes.ts). Started once the port is bound, below.
  const homeRemotes = opts.homeRemotes
    ? createHomeRemotes({
        config: opts.homeRemotes.config,
        ...(opts.homeRemotes.fetch ? { fetch: opts.homeRemotes.fetch } : {}),
        ...(opts.homeRemotes.retryMs !== undefined ? { retryMs: opts.homeRemotes.retryMs } : {}),
        onChange: () => landingChanges.notify('boards'),
      })
    : null;
  const webhookLog: WebhookLogEntry[] = [];
  const webhooks = createWebhookDispatcher({
    ...(opts.webhookFetch ? { fetchImpl: opts.webhookFetch } : {}),
    onLog: (e) => {
      webhookLog.push(e);
      if (webhookLog.length > 1000) webhookLog.shift();
    },
  });
  // `withReviewUrl` is a hoisted function declaration; it captures
  // `server` lazily and is only invoked during requests / thread events,
  // after Bun.serve has assigned. Same instance is reused for SSE +
  // webhook payloads via the DocStore decorator.
  // Generation is opt-IN at this seam: no summarizer, no outbound call, ever.
  // See ServerOptions.summarizer for why constructing one here was wrong.
  const summarizer = opts.summarizer ?? null;
  const pluginRefresher = opts.pluginRefresher ?? null;
  const deployer = opts.deployer ?? null;
  /**
   * When `Bun.serve` returned — the moment this process actually started
   * listening. Null until then, which is what makes `liveness.ok` a claim
   * about the port rather than about the code that would like to bind it.
   */
  let boundAt: number | null = null;
  /**
   * The machine-wide discovery slot, or nothing. Defaulted to "no entry"
   * rather than to a real read: a server built without the seam (every test,
   * every embedded server) has no business resolving the developer's own
   * `~/.claude`, and `bin.ts` is the one place that passes the real reader.
   */
  const readDiscoveryEntry =
    opts.discoveryEntry ?? ((): { port: number; pid: number } | null => null);
  // The meetings: the store, voice feedback, the planning ears, the
  // microphone and bot relays, and calendar join — see meeting-wiring.ts.
  // HERE, before the doc store, because the doc store asks the meeting store
  // whether a doc is recording; everything built later is read through
  // `late`, only once a meeting is live.
  const meetings = wireMeetings({
    dataDir,
    opts,
    sse,
    notifyLanding: (part) => landingChanges.notify(part),
    recallCallbackHost,
    proxiedTrustedHosts,
    anonymousColor: ANONYMOUS_ACTOR.color,
    late: {
      docStore: () => docStore,
      taskStore: () => taskStore,
      taskProjection: () => taskProjection,
      mountStore: () => mountStore,
      readyNudger: () => readyNudger,
      spokenBoard: () => spokenBoard,
      planMinutes: () => planMinutes,
      fileUnderBoardWorkspace: (docId, requested) => fileUnderBoardWorkspace(docId, requested),
      backTargetFor: (docId) => backTargetFor(docId),
      fileReviewRequest: (docId, author, text) => fileReviewRequest(docId, author, text),
      lookupDocs: (workspaceId, exceptDocId) => lookupDocs(workspaceId, exceptDocId),
    },
  });
  const {
    meetingStore,
    voiceRelay,
    meetingEars,
    meetingRelay,
    leadAnswers,
    recallRelay,
    calendarStore,
    calendarSync,
    calendarOauthStates,
  } = meetings;
  // Late-bound because DocStore is constructed before the task store and the
  // projection it needs. Nothing can fire through it until a doc exists,
  // which is after both.
  let onLiveDocEvent: ((docId: string, payload: WebhookPayload) => void) | null = null;
  // Late-bound for the same reason: it reads the roster and the board
  // membership, both built further down. Until then only the owner is trusted.
  let commentTrustFor: CommentTrustFor | null = null;
  let trustBoardsFor: ((docId: string) => Set<string>) | null = null;
  const docStore: DocStore = new DocStore({
    dataDir,
    sse,
    webhooks,
    decorateDocMeta: withReviewUrl,
    onDocEvent: (docId, payload) => onLiveDocEvent?.(docId, payload),
    // A task's comments name the task. Read at fire time, after taskStore exists.
    docTitle: (docId) => {
      const taskId = taskIdOfBodyDoc(docId);
      return taskId ? taskStore.getTask(taskId)?.title : undefined;
    },
    // A doc being recorded into stays resident: the notes reach it by a door
    // no other eviction hold can see. See `DocStoreConfig.isRecording`.
    isRecording: (docId) => meetingStore.active(docId) !== undefined,
    commentTrust: (docId, author) => commentTrustFor?.(docId, author) ?? commentTrustOf(author),
    commentTrustBoards: (docId) => [...(trustBoardsFor?.(docId) ?? [])],
    ...(opts.editSessionIdleMs !== undefined ? { editSessionIdleMs: opts.editSessionIdleMs } : {}),
    ...(summarizer ? { summarizer } : {}),
  });
  // A planning meeting's minutes, under the plan section each is about.
  const boardDocIds = (ws: string) => taskStore.getWorkspace(ws)?.docIds;
  const planMinutes = new PlanMinutes(
    interviewDocs(docStore, boardDocIds),
    (docId) => docStore.peekMeta(docId)?.huddleKind === 'plan',
  );
  // Materialize the shared board-feedback doc at startup rather than letting
  // the first widget connection conjure it. A doc created by a `/y/<id>`
  // connect has no title and no type, so it reads as a ghost in list_docs —
  // and this one is meant to be found and watched by an agent that never
  // visited a board.
  docStore.getOrCreate(BOARD_FEEDBACK_DOC_ID, {
    type: 'mockup',
    title: 'Board feedback (all workspaces)',
  });
  // Server-side half of the double-submit fix: the doc composer's in-flight
  // guard stops ONE call site from ever sending the repeat, this catches
  // whatever gets through anyway (a request that landed but read as a
  // client-side failure, a future caller that reintroduces the race).
  const threadRequestDedup = new ThreadRequestDedup<Thread | null>();
  // The board task store (plan §3.2/§3.3): server-owned workspaces + tasks,
  // persisted as per-workspace sidecars under <dataDir>/workspaces/.
  const taskStore = new TaskStore({
    dataDir,
    ...(opts.heartbeatFreshMs !== undefined ? { heartbeatFreshMs: opts.heartbeatFreshMs } : {}),
    ...(opts.observedWorkFreshMs !== undefined
      ? { observedWorkFreshMs: opts.observedWorkFreshMs }
      : {}),
  });
  taskStore.onWorkspaceCreated = () => landingChanges.notify('boards');
  // Which docs each agent identity is watching — the durable memory behind
  // the MCP child's session-scoped SSE subscriptions, so a respawned session
  // can re-wire them instead of silently starting from `[]`. See
  // agent-watches.ts.
  const agentWatches = new AgentWatches({ dataDir });

  /**
   * A watch key is live when the thing it names still exists: a live doc, or
   * for `ws:<id>` a board workspace / review. Anything else is a subscription
   * the child would open against a 404 forever.
   *
   * Closure-level rather than route-local because two routes need the same
   * answer — the watches list, and the attach response that reports how many
   * watches this session actually has. Two copies would be two definitions of
   * "live" free to drift, on a pair of readings that only mean anything when
   * they agree.
   */
  const watchKeyExists = (key: string): boolean => {
    if (docStore.docExists(key)) return true;
    if (!key.startsWith('ws:')) return false;
    const wsId = key.slice('ws:'.length);
    return (
      taskStore.getWorkspace(wsId) !== undefined ||
      docStore.list().some((m) => m.workspaceId === wsId)
    );
  };
  if (agentWatches.loadError) {
    console.error(`[agent-watches] ${agentWatches.loadError}`);
  }

  // The per-agent memory of turn / denial notes (agent-notes.ts). In-process
  // only: the durable copy is the note pinned to the row it landed on — or,
  // when no row would take it, the line appended to the board's own
  // unplaced-note log below.
  const agentNotes = new AgentNoteRing();
  // Notes no row would take (agent-note-log.ts). A board where one session
  // holds several in-progress rows can place none of its end-of-turn
  // messages, and before this they existed only in the ring above: 20 per
  // agent, read by nothing, gone on restart.
  const agentNoteLog = new AgentNoteLog(dataDir);
  // The repeated-denial watcher (allow-rules.ts): a third denial of one
  // shape in a week files a paste-ready allow rule as a review item. It
  // reads the task notes the routes below append and writes nothing but its
  // own sidecar — never a settings file.
  const allowRules = new AllowRuleProposals(dataDir);
  // The grant card's writer (permission-grants.ts): the ONE path on this
  // server that edits a settings file, built only when bin.ts named one.
  // Its lines come back out when their task closes, and at boot for any
  // close this process missed.
  const permissionGrants = opts.permissionSettingsPath
    ? new PermissionGrants(dataDir, opts.permissionSettingsPath)
    : undefined;
  if (permissionGrants) {
    wirePermissionGrantRelease(taskStore, permissionGrants, (taskId, message) =>
      console.warn(`[feedback] permission grant for ${taskId} not released: ${message}`),
    );
  }
  /**
   * The board's docs as a lookup ask sees them — the three narrow questions
   * `boardLookupDocs` asks, answered from this server's own stores. The
   * rules about what qualifies live there, where they are tested.
   */
  function lookupDocs(workspaceId: string, exceptDocId: string): LookupDoc[] {
    return boardLookupDocs(
      {
        docIds: (id) => taskStore.getWorkspace(id)?.docIds,
        docTitle: (docId) => docStore.peekMeta(docId)?.title,
        // Oldest first, so the newest meeting is the tail.
        lastMeetingAt: (docId) => meetingStore.list(docId).at(-1)?.startedAt,
      },
      workspaceId,
      exceptDocId,
    );
  }

  /** A denial's own agent, as the author of the item it triggered — so the
   *  card says who was blocked, the way a comment-borne ask names its poster. */
  function proposeAllowRule(
    task: Task,
    note: { kind: string; text: string; agent: string; at: number },
  ): void {
    if (note.kind !== 'denial') return;
    let filed: ReturnType<AllowRuleProposals['onDenial']>;
    try {
      filed = allowRules.onDenial(
        taskStore,
        { agent: note.agent, text: note.text, ts: note.at },
        task,
      );
    } catch {
      // The hook's path: a note that landed must not turn into a 500 because
      // the proposal behind it could not be written.
      return;
    }
    if (!filed) return;
    // Same two steps the review-item route takes: re-project so the board
    // doc carries the item, and announce so the queue hears about it.
    taskProjection.refreshTask(filed.task);
    announceTaskReview(filed.task, filed.item, {
      id: agentIdForName(note.agent),
      name: note.agent,
      kind: 'known',
      color: ANONYMOUS_ACTOR.color,
    });
  }
  // Which builder worktrees are working which tasks — the witness that keeps
  // the stall loop from waking a lead over a row whose builder is busy in a
  // checkout the board cannot see. See dispatch-registry.ts.
  //
  // A dispatch on a task that is `done` or archived is over, whatever the
  // registry's own evidence says — the builder's checkout often lingers on
  // disk after its PR merges, so the path check alone kept counting slots
  // for finished work (board, 2026-08-31: `inUse 12 / free 0`, all twelve
  // holders done). The predicate is handed to the registry rather than
  // applied here so EVERY reader — the cap view, the dispatch refusal, the
  // stall gate's watching set, `/api/dispatches` — sees the same pruned set;
  // a task the store cannot find is left to the workspace join below, which
  // cannot attribute it to a board and so never counts it.
  const dispatches = new DispatchRegistry({
    dataDir,
    isTaskOver: (taskId) => {
      const task = taskStore.getTask(taskId);
      return task !== undefined && (task.status === 'done' || task.archivedAt !== undefined);
    },
    ...(opts.dispatchWatchFactory !== undefined ? { watchFactory: opts.dispatchWatchFactory } : {}),
  });
  if (dispatches.loadError) {
    console.error(`[dispatch] ${dispatches.loadError}`);
  }
  if (dispatches.prunedAtBoot.length > 0) {
    console.log(
      `[dispatch] closed ${dispatches.prunedAtBoot.length} stale dispatch(es) at boot: ${dispatches.prunedAtBoot.join(', ')}`,
    );
  }
  // The other end of a dispatch: the builder's one closing report, kept
  // against the TASK so it outlives the lane. `taskStore` is the sink, so a
  // first report rides the ordinary store fan-out and reaches the lead's
  // attached session; a repeat builds no event at all (dispatch-reports.ts).
  // The done-when reader is what lets a report that skips a line be refused by
  // that line's NAME rather than by a count.
  const dispatchReports = new DispatchReportStore({
    dataDir,
    sink: taskStore,
    doneWhenLinesOf: (taskId) =>
      (taskStore.getTask(taskId)?.doneWhen ?? []).map((line) => ({ id: line.id, text: line.text })),
  });
  if (dispatchReports.loadError) {
    console.error(`[dispatch] ${dispatchReports.loadError}`);
  }
  // The row reaching `done` or the archive IS the dispatch's terminal
  // statement — the registry hears it here, so a builder that never sent
  // `close_dispatch` (an older bundle, a crash after the merge) cannot leave
  // its slot held. Prune-on-read above would catch it eventually; this
  // catches it at the moment the board learns.
  taskStore.onEvent((ev) => {
    if ((ev.type === 'task.transitioned' && ev.to === 'done') || ev.type === 'task.archived') {
      dispatches.close(ev.taskId);
    }
  });

  /**
   * Every OPEN dispatch whose task belongs to `workspaceId`, excluding
   * `excludeTaskId` — pass the dispatch's own task there when checking
   * whether IT would push the board over its cap, since re-registering the
   * same task replaces its slot rather than taking a second one.
   *
   * `dispatches` is one registry for the whole server (task ids are unique
   * across boards), so this is the join back to "which board" every caller
   * that wants a per-workspace count needs. A dispatch for a task the store
   * no longer has (soft-deleted, or a stale record from before a restart)
   * cannot be attributed to any board and is silently excluded — the same
   * "coordination state, not user content" posture dispatch-registry.ts
   * already takes with a vanished worktree.
   */
  const dispatchesInWorkspace = (
    workspaceId: string,
    excludeTaskId?: string,
  ): ReturnType<typeof dispatches.list> =>
    dispatches
      .list()
      .filter(
        (d) =>
          d.taskId !== excludeTaskId && taskStore.getTask(d.taskId)?.workspaceId === workspaceId,
      );

  /**
   * The board's parallelism cap as every reader sees it: the number, whether
   * it is the shipped default, how many slots are spent and by whom, and how
   * many are free. ONE builder for the settings route, the cap route, the
   * dispatch refusal, the workspace read and the two nudges — so "in use"
   * cannot mean open dispatches on one surface and in-progress rows on
   * another. A slot is an OPEN DISPATCH (`register_dispatch`): a builder the
   * lead never registered holds none, which is why the lead skill makes
   * registering the dispatch rule rather than a courtesy.
   *
   * Holders carry the task id, its title and the agent's display name — all
   * workspace content, visible to every member by the board's own rule — and
   * never the worktree path, which is host-machine fact (`/api/dispatches`
   * has a visitor check for exactly that; this view is served without one).
   * `undefined` for a board that does not exist.
   */
  const parallelismCapView = (
    workspaceId: string,
    excludeTaskId?: string,
  ):
    | {
        cap: number;
        isDefault: boolean;
        default: number;
        inUse: number;
        free: number;
        holders: Array<{ taskId: string; title?: string; agentName?: string }>;
        /** Who last moved the cap, when, from what — absent until somebody has. */
        lastChange?: ParallelismCapChange;
      }
    | undefined => {
    const read = taskStore.parallelismCap(workspaceId);
    if (!read) return undefined;
    const holders = dispatchesInWorkspace(workspaceId, excludeTaskId).map((d) => {
      const title = taskStore.getTask(d.taskId)?.title;
      return {
        taskId: d.taskId,
        ...(title !== undefined ? { title } : {}),
        ...(d.agentName !== undefined ? { agentName: d.agentName } : {}),
      };
    });
    return {
      cap: read.value,
      isDefault: read.isDefault,
      default: DEFAULT_PARALLELISM_CAP,
      inUse: holders.length,
      free: Math.max(0, read.value - holders.length),
      holders,
      ...(read.lastChange !== undefined ? { lastChange: read.lastChange } : {}),
    };
  };
  /**
   * The cap as a wake names it: the number and, once somebody has moved it,
   * who, when and from what. Both nudgers put this beside the rows they hold
   * for the cap, so "held for the parallelism cap" and "set by X 2h ago" land
   * in the same sentence rather than sending the lead to find out.
   */
  const capSummary = (read: {
    cap?: number;
    value?: number;
    lastChange?: ParallelismCapChange;
  }): { value: number; lastChange?: ParallelismCapChange } => ({
    value: read.cap ?? read.value ?? DEFAULT_PARALLELISM_CAP,
    ...(read.lastChange !== undefined ? { lastChange: read.lastChange } : {}),
  });

  /** One sentence naming who holds the slots, for a refusal or a note. */
  const holdersClause = (
    holders: ReadonlyArray<{ taskId: string; title?: string; agentName?: string }>,
  ): string =>
    holders
      .map(
        (h) =>
          `${h.agentName ?? 'an unnamed agent'} on ${h.title !== undefined ? `"${h.title}"` : h.taskId}`,
      )
      .join(', ');

  // The per-agent unfiled-ask counters the daily chat audit publishes, kept
  // so a session can read its own number back. The audit is the only writer
  // — the server cannot see chat — see chat-audit.ts for the honest limits.
  const chatAudit = new ChatAudit({ dataDir });
  if (chatAudit.loadError) {
    console.error(`[chat-audit] ${chatAudit.loadError}`);
  }

  // The push announcement and the review-item quality gate are built LATER,
  // once `resolveWorkspaceForDoc` and the task projection exist — see
  // `createPushAnnounce` / `createReviewGate` further down. Their functions
  // are only ever called from a route or a hook, so the callers above that
  // name one (`proposeAllowRule`, `stallVerdict`) reach it at request time.

  // Effort scoring — see effort-scoring.ts. Built ABOVE the subscription
  // that calls it, so `scoreEffortEstimate` is declared before its first
  // use: on main it was a hoisted function declaration and the order could
  // not bite, and a `const` in the temporal dead zone would throw if a task
  // event ever fired during init. The projection it re-projects through is
  // built further down, so it arrives as a thunk.
  const { scoreEffortEstimate, rescoreStaleEffortEstimates, stopEffortRescore } =
    createEffortScoring({
      taskStore,
      refreshTask: (task) => taskProjection.refreshTask(task),
      opts,
    });
  // Effort-estimate scoring: re-score a ticket in the background whenever
  // its words — or its goal — change. `task.created`, `task.retitled` and
  // `task.body_edited` are the three doors a title or a body move through —
  // `applyTitle`'s own doc names the seven routes that converge on them —
  // so subscribing here rather than at each route is what makes every one
  // of those routes get scoring for free, batch creation included.
  // `task.regrouped` is the fourth: the goal's own title is part of what the
  // scorer weighs (see `scoreEffortEstimate` above), so moving a ticket to a
  // DIFFERENT goal is a change to the scorer's input even when the title and
  // body never moved. `task.regrouped` also fires on a pure reorder within
  // the same goal (order changed, goal did not) — `fromGoal !== toGoal` is
  // what tells the two apart, so a reorder alone triggers no extra call.
  taskStore.onEvent((ev) => {
    if (ev.type === 'task.created') {
      scoreEffortEstimate(ev.task);
      return;
    }
    if (
      ev.type === 'task.retitled' ||
      ev.type === 'task.body_edited' ||
      (ev.type === 'task.regrouped' && ev.fromGoal !== ev.toGoal)
    ) {
      const task = taskStore.getTask(ev.taskId);
      if (task) scoreEffortEstimate(task);
    }
  });
  // Every store event rides the existing SSE pipeline on the workspace
  // channel (`ws~<workspaceId>`, the same channel doc thread events use for
  // reviews) — no new transport (§3.6). The audit log
  // append happens inside the store's emit, not here.
  //
  // ONE exclusion: `task.noted` never rides the stream. An attached MCP
  // child relays every task.* frame it has no line for as a channel message
  // to its session, so a broadcast note would wake every other agent on the
  // board once per turn of the agent that posted it — and two agents each
  // holding a row would wake each other without end. Nothing on the stream
  // needs it: the ydoc projection carries the notes and the audit log has
  // the event. Excluded here, on the server, because a bundle-side filter
  // only takes effect for sessions that have restarted onto it.
  //
  // `dispatch.requested` is excluded for the same reason and by the same
  // argument: it is a timing marker for the audit log, nothing on any surface
  // reads it, and relaying it would spend a wake turn of every other agent on
  // the board every time the lead started a builder. The measurement it exists
  // for is read out of `events.jsonl` after the fact, so the stream is not a
  // path it needs.
  //
  // `review_item.viewed` is the third, and it is the same rule stated for
  // measurement rather than for noise: an event that exists for analytics
  // does not reach a listening agent. A person opening a card changes no task
  // and no status, and no page reads the frame either — the board POSTs the
  // beacon and never listens for it. `ANALYTICS_ONLY_EVENTS` in
  // `review-items/analytics.ts` holds the list and says why
  // `review_item.answered` is not on it.
  taskStore.onEvent((ev) => {
    if (ev.type === 'task.noted' || ev.type === 'dispatch.requested') return;
    if (isAnalyticsOnlyEvent(ev.type)) return;
    const { type, ...rest } = ev;
    sse.broadcast(`ws~${ev.workspaceId}`, { event: type, ...rest });
  });
  // The second half of the liveness gate, and the half a time window cannot
  // supply: a delivery rides `ws~<workspaceId>`, so if nobody holds that
  // stream it lands nowhere. An agent that died thirty seconds after its last
  // write is still inside every freshness window and is already gone; only
  // the open socket knows.
  //
  // This can only ever make the gate MORE conservative — the store ANDs it
  // with observed freshness, so a subscriber alone never counts as live.
  // That direction is deliberate and it is the safe one: browsers watch the
  // same channel as agents, so a probe read as sufficient would let an open
  // tab impersonate a working agent, and the utterance would be broadcast to
  // a listener that cannot act on it and lost. Queued is late; delivered to
  // nobody is gone.
  taskStore.setDeliveryProbe((workspaceId) => sse.count(`ws~${workspaceId}`) > 0);
  // …and the stronger, agent-specific form of the same question. `count`
  // cannot tell an agent from a browser tab, so it may only ever narrow a
  // delivery decision; this one is keyed by the agentId the agent's own MCP
  // child puts on its stream, so it may widen one.
  taskStore.setAgentStreamProbe((workspaceId, agentId) =>
    sse.agentsOn(`ws~${workspaceId}`).has(agentId),
  );
  // The ydoc projection (§3.3): ws:<workspaceId> board docs the server
  // writes and defends (foreign writes reverted), plus task:<taskId> body
  // docs. init() runs after both stores hydrated, so the sidecar is
  // authoritative for gated fields on restart.
  const taskProjection = new TaskProjection({ docStore, tasks: taskStore });
  taskProjection.init();

  // Provenance stamping at the store's one choke point: every create whose
  // origin names a doc records the doc's settled content revision, whichever
  // route (or the meeting capture) filed it.
  taskStore.setDocRevisionReader((docId) => docStore.settledContentRevision(docId));
  // When a doc last changed, for a rule that runs on that (scheduled-tasks.md).
  taskStore.setDocActivityReader((docId) => docStore.activityAt(docId));
  // The OTHER way to ask a person, made visible to the readiness gate.
  //
  // `add_review_item` writes into `task.reviews`, which the store reads
  // itself. `create_thread(docId: 'task:<id>', review)` writes a payload onto
  // a comment in the ticket's body doc, which the store cannot see — so a row
  // whose only open question was filed that way counted as having none, and
  // was nudged as idle and reported as stalled against the agent that
  // correctly filed and correctly stopped. Both tools are documented as ways
  // to ask, so the gate learns to read both rather than one being retired.
  //
  // `pendingDeclaration` is the house predicate, not a second rule written
  // here: an OPEN thread, its newest un-withdrawn review payload, unanswered.
  // A GATED payload — held, or still being judged — is skipped for the same
  // reason a gated ticket item is left out of `open` (`isReviewItemOnQueue`):
  // nobody was shown it, so it cannot excuse the row. `isReviewPayloadGated`
  // is the queue's own spelling of that; this used to test `held` alone and
  // count an item mid-judgement as open.
  taskStore.setThreadAskReader((taskId) => {
    let open = 0;
    for (const thread of docStore.listThreads(`task:${taskId}`, { status: 'open' })) {
      const pending = pendingDeclaration(thread);
      if (pending?.review && !isReviewPayloadGated(pending.review)) open += 1;
    }
    return open;
  });
  // …and the return half: a settled edit burst on a doc flags the open rows
  // derived from an earlier revision of it. Flagging emits no store event
  // (§3.6's table is exhaustive), so the projection refresh happens here,
  // the same pattern as the links route.
  docStore.onContentRevision = (docIds, revision) => {
    const touched = new Set(taskStore.flagStaleFromDocEdit(docIds, revision));
    // The settled doc's prose is the linkage record: any task/goal link the
    // edit wrote (or that was never mined) becomes a structured ref now, so
    // the Docs field on the row side stays true without a second call. Ids
    // arrive as canonical + alias; scanning the first that resolves scans
    // the one doc they both name.
    const scanned = new Set<string>();
    for (const docId of docIds) {
      const canonical = docStore.resolveDocId(docId);
      if (scanned.has(canonical)) continue;
      scanned.add(canonical);
      for (const wsId of scanSettledDocRefs(docStore, taskStore, canonical)) touched.add(wsId);
    }
    for (const workspaceId of touched) {
      taskProjection.ensureWorkspace(workspaceId);
    }
  };

  // The done-artifact check (artifact-check.ts): a move to done gets the
  // row's links verified after the transition commits — a dead PR link or a
  // vanished doc surfaces as a system comment on the task's discussion, the
  // park-note pattern. Advisory end to end: nothing here can block, slow, or
  // fail a transition, and a lookup that cannot answer stays quiet.
  const artifactChecker = new ArtifactChecker({
    getTask: (id) => taskStore.getTask(id),
    record: (id, result) => void taskStore.recordArtifactCheck(id, result),
    // A doc exists if a live doc holds it or an archive manifest does —
    // archiving is the board's reversible removal, so a retired doc still
    // counts as delivered. Review members archive under a set manifest, not
    // a per-doc one, so both archive shapes are consulted.
    docStatus: (docId) => {
      if (docStore.list().some((m) => m.docId === docId)) return 'live';
      if (readDocArchiveManifest(dataDir, docId) !== null) return 'archived';
      if (listArchivedReviews(dataDir).some((m) => m.docIds.includes(docId))) return 'archived';
      return 'missing';
    },
    postMissingNote: async (task, text) => {
      taskProjection.ensureTaskBody(task);
      // Same actor-shape cast as the park migration's comment: the server's
      // own identity, rendered as a known author rather than an anonymous one.
      await docStore.postComment(
        taskBodyDocId(task.id),
        null,
        { ...ARTIFACT_CHECK_ACTOR, kind: 'known' } as unknown as User,
        text,
        { kind: 'subject' },
        // Machine-written and short: not worth an outbound summary call.
        { generate: false },
      );
    },
    ...(opts.artifactCheckFetch !== undefined ? { fetchImpl: opts.artifactCheckFetch } : {}),
    ...(opts.artifactCheckTimeoutMs !== undefined
      ? { timeoutMs: opts.artifactCheckTimeoutMs }
      : {}),
    log: (line) => console.error(line),
  });
  artifactChecker.install(taskStore);
  // The doc<->board membership map: which boards hold a doc, who may reach it
  // through one, and whether an agent's watch set actually covers them. One
  // subject, one module (`board-membership.ts`); `createServer` composes it
  // and does not derive any of it.
  //
  // Composed HERE, above the stall wiring, because everything it reads is
  // already built — `docStore`, both stores, and the access deps at the top of
  // this function. That is what lets `boardsForDoc` and `backTargetFor` go
  // into the wiring below as VALUES rather than as thunks over a block
  // declared later in the file.
  const {
    shareWorkspacesOf,
    collabMemberOf,
    shareLinkMemberOf,
    audienceMemberOf,
    redeemShareLink,
    boardRoleOf,
    boardsForDoc,
    boardIndexForListing,
    boardsForDocIndexed,
    homeForDocIndexed,
    watchCoverageFor,
    backTargetFor,
    fileUnderBoardWorkspace,
    unfileFromDefault,
    unlinkFromEveryBoardWorkspace,
    defaultBoardWorkspaceId,
  } = createBoardMembership({
    docStore,
    taskStore,
    taskProjection,
    shares,
    shareLinks,
    boardShareTarget,
    proxiedTrustedEmails,
    boardSharingOpen: (workspaceId) => sharingGate.isBoardOpen(workspaceId),
  });

  // The stall / ready-work wiring — both per-board snapshots, the two
  // nudgers, the lead-presence monitor, the ready clock's store subscription
  // and the comment-queue bridge. One documented subsystem
  // (docs/architecture/stall-detection.md), so it is one module:
  // `stall-wiring.ts`. `createServer` composes it and arms the nudgers below;
  // it does not derive any of it.
  //
  // ONE member of the context is a FUNCTION rather than a value —
  // `reviseCallFor` — because the review gate is built further down this file
  // than this line, and it is only ever reached from a request or an event.
  // Passing it deferred is what lets this stay here: the gate is built where
  // it is because it needs `resolveWorkspaceForDoc` and the task projection,
  // and hoisting it to satisfy a declaration order would trade one ordering
  // constraint for a worse one.
  //
  // `boardsForDoc` and `backTargetFor` used to be thunks for the same
  // reason and are now values: the membership map they come from is composed
  // above this line, so there is nothing left to defer.
  // Team Lead — the fleet's spawner — is the first addressee past a dead
  // board's lead (`stall-escalation.ts`) and the scheduled wake's addressee
  // below. One id, computed once, so the two cannot name different sessions.
  const spawnerAgentId =
    opts.spawnerAgentId === null
      ? undefined
      : (opts.spawnerAgentId ?? process.env.CW_SPAWNER_AGENT_ID ?? DEFAULT_SPAWNER_AGENT_ID);
  const stallWiring = createStallWiring({
    taskStore,
    taskProjection,
    docStore,
    sse,
    dispatches,
    agentWatches,
    dataDir,
    parallelismCapView,
    capSummary,
    boardsForDoc,
    backTargetFor,
    reviseCallFor: (address) => reviseCallFor(address),
    releaseUnrevisedHold: (item) => releaseUnrevisedHold(item),
    externalBaseUrl: () => externalBaseUrl(),
    ...(opts.readyNudgeIdleMs !== undefined ? { readyNudgeIdleMs: opts.readyNudgeIdleMs } : {}),
    ...(opts.stallNudgeQuietMs !== undefined ? { stallNudgeQuietMs: opts.stallNudgeQuietMs } : {}),
    ...(opts.checkInMs !== undefined ? { checkInMs: opts.checkInMs } : {}),
    ...(opts.stallBuilderSilentMultiplier !== undefined
      ? { stallBuilderSilentMultiplier: opts.stallBuilderSilentMultiplier }
      : {}),
    ...(opts.stallNudgeRepeatMs !== undefined
      ? { stallNudgeRepeatMs: opts.stallNudgeRepeatMs }
      : {}),
    ...(opts.stallEscalateMs !== undefined ? { stallEscalateMs: opts.stallEscalateMs } : {}),
    ...(spawnerAgentId !== undefined ? { spawnerAgentId } : {}),
    ...(opts.heldReviewItemMs !== undefined ? { heldReviewItemMs: opts.heldReviewItemMs } : {}),
    ...(opts.heldReleaseMs !== undefined ? { heldReleaseMs: opts.heldReleaseMs } : {}),
    ...(opts.keepMovingCadenceMs !== undefined
      ? { keepMovingCadenceMs: opts.keepMovingCadenceMs }
      : {}),
  });
  const { leadPresence, readyNudger, stallNudger } = stallWiring;

  // The scheduled-task loop (docs/architecture/scheduled-tasks.md). Built
  // beside the two nudgers because it is the third thing on this server that
  // runs on a clock rather than on a request, and armed with them below.
  // `schedulerNow` is a seam for the same reason `stallNudgeQuietMs` is one:
  // the feature IS a comparison against a clock, so a test that could not move
  // the clock would have to burn real minutes to assert anything.
  let runOutputSource = (): RunOutputSource => ({ files: () => null });
  const taskScheduler = createTaskScheduler(taskStore, {
    ...(opts.schedulerNow !== undefined ? { now: opts.schedulerNow } : {}),
    observers: [
      // The wake rides the same addressed delivery the two nudgers use, and
      // reaches the spawner on whichever board it holds a stream.
      observeScheduledWake(
        taskStore,
        {
          canReach: (workspaceId, agentId) => sse.agentsOn(`ws~${workspaceId}`).has(agentId),
          send: (workspaceId, agentId, frame) =>
            sse.sendToAgent(`ws~${workspaceId}`, agentId, { ...frame }),
          ...(spawnerAgentId !== undefined ? { spawnerAgentId } : {}),
          report: (message) => console.error(message),
        },
        SCHEDULER_ACTOR,
      ),
      // A declared output folder's new files reach Home as one item per run.
      // The Library's context is built further down; a tick reads it late.
      observeRunOutput(
        taskStore,
        {
          files: (ws) => runOutputSource().files(ws),
        },
        SCHEDULER_ACTOR,
        (message) => console.error(message),
      ),
    ],
  });
  // The late binding `DocStore` was constructed with: the bridge needs the task
  // store and the projection, which are built after `DocStore` is.
  onLiveDocEvent = stallWiring.onLiveDocEvent;

  // ── Home pane: per-person read markers + the "What's New?" brief ─────────
  // One subject, one module (`home-pane.ts`); `createServer` composes it here
  // because everything the pane reads — the stores, the doc store and the
  // summarizer seam — is in hand by this line, and the routes below take the
  // same four names off it that they used to take off this closure.
  const { homeBriefs, reviewItemsFor, sizer, homePayload } = createHomePane({
    dataDir,
    taskStore,
    docStore,
    summarizer,
  });
  // Which boards and docs keep their files here, so a lead stream off this
  // machine gets none of their asks. Two of the stores it reads are built
  // further down; it runs only for a frame on such a stream (ask-feed.ts).
  const localOnlyPlaces = localOnlyPlacesFrom({
    isLocalOnlySet: (setId) => attachmentPrivacy.isLocalOnly(setId),
    setOfDoc: (docId) => setOfDoc(docId),
    docKeyOf: (docId) => docStore.repos.primaryKeyFor(docStore.resolveDocId(docId)),
    projectIsLocalOnly: (repoKey) => mountStore.privacyOf(repoKey) === 'local-only',
    docIdsOf: (id) => taskStore.getWorkspace(id)?.docIds ?? [],
  });
  /** The coach: the owner's learning goals, what he is doing, and the moments
   *  it raises (coach/wiring.ts). The Coach board's lead session hears every
   *  event; with no session listening, the coach stays quiet. */
  const coachWiring = wireCoach({
    dataDir,
    docStore,
    createBoard: (name) => taskStore.createWorkspace(name).id,
    fileUnderBoard: (docId, workspaceId) => {
      fileUnderBoardWorkspace(docId, workspaceId);
    },
    label: (docId) => {
      const task = docId.startsWith('task:') ? taskStore.getTask(docId.slice(5)) : undefined;
      const ws = task?.workspaceId ?? taskStore.workspaceOfDoc(docId);
      const board = ws ? taskStore.getWorkspace(ws)?.name : undefined;
      const title = task?.title ?? docStore.get(docId)?.meta.title ?? undefined;
      return { ...(title ? { title } : {}), ...(board ? { board } : {}) };
    },
    boardName: (workspaceId) => taskStore.getWorkspace(workspaceId)?.name,
    workspaceOf: (docId) =>
      docId.startsWith('task:')
        ? taskStore.getTask(docId.slice(5))?.workspaceId
        : (taskStore.workspaceOfDoc(docId) ?? undefined),
    // Built further down; read only for a page's or a row's event.
    docBoards: { boardsOfDoc: (docId) => [...boardsForDoc(docId)] },
    leadOf: (workspaceId) => taskStore.getWorkspace(workspaceId)?.leadAgentId,
    sendToAgent: (workspaceId, agentId, frame) =>
      sse.sendToAgent(`ws~${workspaceId}`, agentId, { ...frame }),
    agentConnected: (workspaceId, agentId) => sse.agentsOn(`ws~${workspaceId}`).has(agentId),
    planBoard: () => {
      const id = crossReview.projects().planWorkspaceId;
      const board = id ? taskStore.getWorkspace(id) : undefined;
      return board ? planBoardReading(board.goals, taskStore.listGoalRows(board.id)) : undefined;
    },
    ...(opts.coachSummarizer ? { summarizer: opts.coachSummarizer } : {}),
    ...(opts.coachDigestWindowMs === undefined ? {} : { digestWindowMs: opts.coachDigestWindowMs }),
  });
  // "Your coach" on `/` reads the coach store, the goals doc and whether the
  // coach session is connected. None of the three broadcasts, so each tells
  // the workspaces list's feed itself.
  coachWiring.store.onChange = () => landingChanges.notify('coach');
  {
    const onRevision = docStore.onContentRevision;
    docStore.onContentRevision = (docIds, revision) => {
      onRevision?.(docIds, revision);
      const goals = coachWiring.store.goalsDoc?.docId;
      if (goals && docIds.includes(goals)) landingChanges.notify('coach');
    };
    const onAgentStreams = sse.onAgentStreams;
    sse.onAgentStreams = (channel, agentId) => {
      onAgentStreams?.(channel, agentId);
      const board = coachWiring.store.goalsDoc?.workspaceId;
      if (board && channel === `ws~${board}`) {
        landingChanges.notify('coach');
        // The coach session is back: what waited while it was away goes now.
        coachWiring.agentStreamsChanged(board, agentId);
      }
    };
  }
  /** The plan lead's per-item ranks and its batched feed of new asks
   *  (lead-rank-wiring.ts), over every board: the lead sees what the owner
   *  sees (the owner, 2026-10-23). */
  const leadRanks = wireLeadRanks({
    dataDir,
    planBoard: () => crossReview.projects().planWorkspaceId,
    leadOf: (workspaceId) => taskStore.getWorkspace(workspaceId)?.leadAgentId,
    boardName: (workspaceId) => taskStore.getWorkspace(workspaceId)?.name,
    goalTitle: (goalId) => taskStore.getGoalRow(goalId)?.title,
    taskWorkspace: (taskId) => taskStore.getTask(taskId)?.workspaceId,
    goalWorkspace: (rowId) => taskStore.getGoalRow(rowId)?.workspaceId,
    boardsForDoc: (docId) => boardsForDoc(docId),
    onTaskEvent: (listener) => taskStore.onEvent(listener),
    sendToAgent: (workspaceId, agentId, frame) =>
      sse.sendToAgent(`ws~${workspaceId}`, agentId, { ...frame }),
    agentConnected: (workspaceId, agentId) => sse.agentsOn(`ws~${workspaceId}`).has(agentId),
    ...(opts.askFeedWindowMs === undefined ? {} : { askWindowMs: opts.askFeedWindowMs }),
  });
  // Where each agent points, in its boards' presence rooms (agent-spots.ts).
  const agentSpots = createAgentSpots({
    boardsForDoc: (docId) => boardsForDoc(docId),
    boardAwareness: (workspaceId) =>
      docStore.peek(workspaceDocId(workspaceId))?.peekAwareness() ?? null,
    surfaceOf: (docId) => (docStore.peekMeta(docId)?.type === 'whiteboard' ? 'whiteboard' : 'doc'),
    listening: (workspaceId, agentId) => sse.agentsOn(`ws~${workspaceId}`).has(agentId),
  });
  {
    const onAgentStreams = sse.onAgentStreams;
    sse.onAgentStreams = (channel, agentId) => {
      onAgentStreams?.(channel, agentId);
      if (channel.startsWith('ws~')) agentSpots.streamsChanged(channel.slice(3));
    };
  }
  {
    const stallDocEvent = stallWiring.onLiveDocEvent;
    onLiveDocEvent = (docId, payload) => {
      stallDocEvent(docId, payload);
      leadRanks.onDocEvent(docId, payload);
      agentSpots.onDocEvent(docId, payload);
    };
  }
  // One queue over every board, in project order, and the ledger that records
  // where each answered item stood in it. Composed beside the Home pane
  // because it reads that pane's own rows — the cross-board order and a
  // board's Home order are one computation.
  const crossReview = createCrossReview({
    dataDir,
    taskStore,
    docStore,
    reviewItemsFor,
    sizer,
    lastActivityOf: (w) => boardLastActivity(docStore, taskStore, w),
    spawnerAgentId: spawnerAgentId ?? null,
    leadRank: leadRanks.leadRank,
    leadGoal: leadRanks.leadGoal,
    onError: (err) => captureServerError(err, { where: 'cross-review answer ledger' }),
  });
  /** The plan board's goals in band order: what a goal tag names, and the
   *  order Home's goal sections follow. The server-owned bucket is no goal. */
  const planGoals = (workspaceId: string | undefined) =>
    (workspaceId ? (taskStore.getWorkspace(workspaceId)?.goals ?? []) : []).filter(
      (g) => !isReservedGoalId(g.id),
    );
  const boardSummaries = createBoardSummaries({
    dataDir,
    summarizer,
    titleOf: (taskId) => taskStore.getTask(taskId)?.title,
  });
  /**
   * Rewrite a task's description through its live `task:<id>` body doc, with
   * everything the act owes: the doc exists, the snapshot the board and
   * `next_tasks` read is fresh immediately rather than on the debounce, and —
   * when the caller said who it is — an attributed `task.body_edited` row.
   *
   * ONE function because there are TWO routes: `POST /api/tasks/:id/body` and
   * `POST /api/docs/task:<id>/content`. The second one used to reach
   * `docStore.setDocContent` directly and got none of this, which is how a
   * rewrite through `set_doc_content` destroyed a capture with nothing
   * recorded while both the caller and the board saw success.
   *
   * The preservation into `quote` is deliberately NOT here. It lives at
   * `TaskStore.updateBodySnapshot`, the choke point every writer of a body
   * fragment passes through — including `find_and_replace` on the same docId
   * and a person typing on the board, neither of which comes through this
   * function. Putting it here would rebuild the exact gap being closed, one
   * layer up.
   */
  const rewriteTaskBody = (
    task: Task,
    markdown: string,
    opts: {
      actor?: { id: string; name: string; kind?: string };
      title?: string;
      reason?: string;
    },
  ): { ok: true } | { ok: false; error: string } => {
    const docId = taskProjection.ensureBodyDoc(task);
    const res = docStore.setDocContent(docId, markdown);
    if (!res.ok) return res;
    taskProjection.flushBodySnapshot(task.id);
    // Attribution is the one half a route can lack: `POST /api/docs/:id/content`
    // has never required an author, and an audit row naming nobody is worse
    // than the honest absence of one. The words are safe either way — the
    // snapshot flush above has already preserved them.
    if (opts.actor) {
      taskStore.noteBodyEdited(task.id, {
        actor: opts.actor,
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      });
    }
    return { ok: true };
  };
  // Deploy readiness (§3.12 commit 11): uptime is measured from the same
  // events.jsonl the audit trail lives in. The monitor stamps
  // server.started now (bounding whatever outage this boot ended) and
  // beats server.tick so an idle workspace's log still has gap-analysis
  // density. Markers bypass taskStore.emit on purpose — §3.6's table has
  // no server.* rows, and SSE/MCP subscribers must not see a beat every
  // five minutes.
  const uptimeMonitor = new UptimeMonitor({
    dataDir,
    tasks: taskStore,
    ...(opts.uptimeTickMs !== undefined ? { tickMs: opts.uptimeTickMs } : {}),
  });
  uptimeMonitor.start();
  // Voice routing (§3.8): lookups take the Haiku fast path when a completer
  // was injected; changes go to the attached agent (or the on-disk queue).
  const voiceRouter = new VoiceRouter({
    tasks: taskStore,
    ...(opts.answerCoverage ? { answerCoverage: opts.answerCoverage } : {}),
    // Read per utterance, so an edit on the settings page reaches the next
    // thing spoken without a restart.
    instructions: () => promptStore.read('voice-router'),
    ...(opts.voiceComplete
      ? opts.voiceRouterArm === 'choice'
        ? { classify: routerClassifier(opts.voiceComplete) }
        : { complete: opts.voiceComplete }
      : {}),
    // What a doc in view HOLDS, read through the one review-item builder this
    // server already has. Voice must not grow a second notion of "what is
    // waiting on a person here": that shape is owned by review-queue.ts and
    // is being reworked, and a private copy would drift the day it lands.
    // The router only ever calls this for a docId it has already proved is
    // attached to the workspace.
    docResource: (workspaceId, docId) => {
      const workspace = taskStore.getWorkspace(workspaceId);
      if (!workspace) return undefined;
      const meta = docStore.peekMeta(docId);
      // Title, else the file's BASENAME — never the path. Same rule, and the
      // same reason, as the review-items route: a label is workspace content,
      // a host path is not, and this text leaves the machine.
      const title = meta?.title || meta?.relPath?.split('/').pop();
      return {
        ...(title ? { title } : {}),
        reviewItems: reviewItemsFor(workspace)
          // A queue row now hangs on EITHER a comment or a ticket (#254). Only
          // the comment-shaped ones address a `docId`/`threadId`/`commentId`,
          // and only those are things this DOC holds — a ticket review item is
          // answered against `taskId`/`reviewItemId` and belongs to the task
          // surface, not to a doc in view. Narrowed with a predicate rather
          // than a bare `.filter`, because `.filter` alone leaves the union
          // intact and the field reads below would not compile.
          .filter(
            (item): item is SizedReviewItemRow & ReviewThreadItem =>
              item.kind !== 'task-review' && item.docId === docId,
          )
          .map((item) => ({
            threadId: item.threadId,
            commentId: item.commentId,
            // Whether `answerReviewItem` can stamp an answer onto it, which is
            // true exactly when the comment carries the declaration. Read from
            // the item rather than discovered from that function's error
            // string: it decides which existing doc write voice calls, and a
            // plain open question (the `unreplied` band — since the membership
            // narrowing, direct asks only rather than most of the queue)
            // gets a plain threaded reply instead of a silent deferral.
            answerable: item.review !== undefined,
            ask: item.ask,
            askedBy: item.askedBy,
            // The labels a spoken pick is matched against, with the ids the
            // answer is stamped with — the same pair a tapped button sends.
            ...(item.review?.options?.length
              ? { options: item.review.options.map((o) => ({ id: o.id, label: o.label })) }
              : {}),
          })),
      };
    },
    // A doc's LABEL, for matching "the Cairn review doc" against what the
    // board calls it. Title, else the file's basename — never the path, for
    // the reason given twice above.
    docTitle: (_workspaceId, docId) => {
      const meta = docStore.peekMeta(docId);
      // Title, else the file's NAME. The review-items route stops at
      // `relPath`'s basename because a share visitor reads it; this label
      // reaches only the local speaker's ack and the classification prompt,
      // and a bare filename ("expansion-plan.md") is what a doc bound without
      // a title is called everywhere else. Directories never come along.
      const file = (meta?.relPath ?? meta?.sourceUrl ?? '').split('/').pop();
      return meta?.title || (file ? file.replace(/\.[a-z0-9]+$/i, '') : undefined) || undefined;
    },
    // What is waiting on a person, board-wide, for "brief status" — the SAME
    // rows the Home queue renders, so the count voice says is the count the
    // reader sees when they look.
    queue: (workspaceId) => {
      const workspace = taskStore.getWorkspace(workspaceId);
      if (!workspace) return [];
      return reviewItemsFor(workspace).map((item) => ({
        title: item.title,
        ask: item.ask,
        askedBy: item.askedBy,
      }));
    },
    // The doc store itself, for the two text verbs. Voice calls
    // `postComment` — the one choke point every reply path in this server
    // already funnels through — and `answerReviewItem` exactly as it stands,
    // so a spoken comment and a typed one are the same write, fire the same
    // events, and reach a watching agent identically.
    docStore,
    // A task's discussion doc, CREATED if this process has not served it
    // yet. Body docs are lazy, so on a freshly restarted server the doc for
    // a task nobody has opened does not exist and a comment aimed straight at
    // `task:<id>` is dropped with a `null` the caller reads as "no such doc".
    taskCommentDoc: (taskId) => {
      const task = taskStore.getTask(taskId);
      return task ? taskProjection.ensureBodyDoc(task) : undefined;
    },
  });
  // The board mic's spoken reply: the same router's answer, heard and said
  // by the engines `server-deps.ts` built (none here unless injected).
  const spokenTimings = new SpokenTimings(join(dataDir, SPOKEN_TIMINGS_FILE));
  // Setup 4's live sockets, by the token ElevenLabs hands back to the
  // custom-LLM route (`routes/voice-agent-llm.ts`).
  const agentCallbacks = new AgentCallbacks();
  const spokenBoard: SpokenBoard = {
    handle: (workspaceId, req) => voiceRouter.handle(workspaceId, req),
    goalStatus: (workspaceId, goalId) => voiceRouter.goalStatus(workspaceId, goalId),
    goals: (workspaceId) =>
      (taskStore.getWorkspace(workspaceId)?.goals ?? []).map((g) => ({
        id: g.id,
        title: g.title,
      })),
    // The Home tab's own rows, so the voice queue reads what the screen shows.
    reviewQueue: (workspaceId) => {
      const workspace = taskStore.getWorkspace(workspaceId);
      return workspace ? reviewItemsFor(workspace) : [];
    },
    ...(opts.voiceComplete ? { explain: opts.voiceComplete } : {}),
  };
  // A turn for one named agent: its own row and its own streams, never a
  // broadcast (`spoken-reply/agent-conversation.ts`). The converse socket
  // and the voice API (`voice-api/`) both speak through it.
  const voiceAgentLine = agentLine({
    listAttachments: (workspaceId) => taskStore.listAttachments(workspaceId),
    displayName: (agentId) => identities.displayNameFor(agentId) ?? undefined,
    queueComment: (workspaceId, item) => taskStore.queueComment(workspaceId, item),
    markCommentEmitted: (workspaceId, id) => taskStore.markCommentEmitted(workspaceId, id),
    sendToAgent: (workspaceId, agentId, frame) =>
      sse.sendToAgent(`ws~${workspaceId}`, agentId, frame),
  });
  // The board's lead chat (`lead-chat/`): typed and spoken turns to the lead,
  // one log per board, every change sent to the board's pages only.
  const leadChat = new LeadChat({
    log: new LeadChatLog(dataDir),
    line: voiceAgentLine,
    leadOf: (workspaceId) => {
      const agentId = taskStore.getWorkspace(workspaceId)?.leadAgentId;
      if (!agentId) return null;
      return { agentId, name: voiceAgentLine.attached(workspaceId, agentId)?.name ?? agentId };
    },
    broadcast: (workspaceId, frame) =>
      sse.broadcastTransient(`ws~${workspaceId}`, frame, { skipAgentStreams: true }),
    newId: () => cryptoId('lc'),
  });
  // What the lead's session writes mid-turn and the tools it calls.
  const leadSessionMirror = new LeadSessionMirror(leadChat, () => cryptoId('lc'));
  // The meeting a board's lead chat runs (`lead-chat/meeting.ts`), on the
  // same page-only channel.
  const leadChatMeetings = new LeadChatMeetings({
    dataDir,
    broadcast: (workspaceId, frame) =>
      sse.broadcastTransient(`ws~${workspaceId}`, frame, { skipAgentStreams: true }),
    newId: () => cryptoId('lcm'),
  });
  const spokenEngines = opts.spokenReply ?? {
    listener: null,
    voices: { 1: null, 2: null },
    gemini: null,
  };
  const spokenRelay = new SpokenReplyRelay({
    leads: leadAnswers,
    agentLine: voiceAgentLine,
    conversationLog: {
      turn: (...args) => leadChat.voiceTurn(...args),
      replied: (...args) => leadChat.voiceReply(...args),
    },
    engines: spokenEngines,
    board: spokenBoard,
    timings: spokenTimings,
    agentCallbacks,
    parseContext: parseVoiceContext,
    // The planning voice: a plan read at each pause, answers written in.
    interview: {
      // Its cursor is also its spot in the board's presence room.
      docs: interviewDocs(
        docStore,
        boardDocIds,
        meetingEars,
        (docId, headingId) => planMinutes.talkedAbout(docId, headingId),
        voicePointer(agentSpots),
      ),
      log: new InterviewLog(join(dataDir, INTERVIEW_TIMINGS_FILE)),
      ...(opts.voiceComplete ? { complete: opts.voiceComplete } : {}),
      ...(opts.planWarmupMs !== undefined ? { warmupMs: opts.planWarmupMs } : {}),
    },
    // A recording meeting: a plan's is heard for its questions, any for
    // "Claude, …" from the owner (`spoken-reply/meeting-ask.ts`).
    meetingEars: (docId) =>
      meetingEars.recording(docId)
        ? {
            engine: meetingEars.engine(docId),
            plan: docStore.peekMeta(docId)?.huddleKind === 'plan',
            note: (markdown, about) => {
              if (!planMinutes.place(docId, markdown, about)) meetingEars.note(docId, markdown);
            },
            recent: () =>
              meetingContext(docStore.readMarkdownBody(docId), meetingEars.recentSpeech(docId)),
          }
        : null,
  });

  /** A path segment, decoded, answering itself rather than throwing on `%`. */
  const safeDecodeSegment = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };

  /**
   * The Review ask, filed: a subject thread on the doc carrying `text` from
   * `author`, and the doc stamped as review-requested naming that thread so
   * the float can offer another ask once it is resolved. One function for
   * both triggers — the float's press and the meeting assistant hearing
   * "ask the team whether…" — so a spoken ask and a tapped one land as the
   * same thing. Null when the doc does not exist.
   */
  const fileReviewRequest = async (
    docId: string,
    author: User,
    text: string,
  ): Promise<{ threadId: string; requestedAt?: number } | null> => {
    const thread = await docStore.postComment(
      docId,
      null,
      author,
      text,
      { kind: 'subject' },
      { generate: false },
    );
    if (!thread) return null;
    const stamped = docStore.setReviewRequested(docId, author.name, thread.id);
    return { threadId: thread.id, ...(stamped.ok ? { requestedAt: stamped.requestedAt } : {}) };
  };

  /**
   * ── Addressing: one prefix, and the compat layer that keeps the old ones
   * answering. ──
   *
   * Every resource lives under the workspace it belongs to:
   *
   *   /workspaces/<workspaceId>                     the board
   *   /workspaces/<workspaceId>/docs/<docId>        a doc, of any content kind
   *   /workspaces/<workspaceId>/mockups/<docId>     a mockup's own HTML
   *   /workspaces/<workspaceId>/attachments/<setId>  a set, → its entry doc
   *
   * `/review/<docId>` and `/mockup/<docId>` are the addresses these used to
   * have. They still answer, and they always will: those URLs sit in comment
   * threads, in bookmarks, and in `entryUrl` values returned by plugin bundles
   * running in sessions nobody can restart. A 404 there reads, to the person
   * holding the link, exactly like the review having been deleted.
   */

  /** 302 with the query string preserved. `?mobile=<preset>` rides on it. */
  const redirectTo = (path: string, search: string): Response =>
    new Response(null, { status: 302, headers: { location: `${path}${search}` } });

  /**
   * The doc's own id, for a request that addressed it by a readable alias.
   *
   * The `/api/docs/<id>/…` block canonicalizes for the ~30 subroutes inside
   * it. This is for the doc routes matched OUTSIDE that block — they exist
   * because they must run before it or without a doc, and each one is a
   * place where "the alias works everywhere" quietly stopped being true.
   * `doc-id-routes.test.ts` walks the whole surface by alias so the next one
   * added without this goes red rather than out.
   *
   * Unknown ids pass through unchanged, so a 404 still reads as "no such
   * doc" rather than becoming a different error on the way.
   *
   * A name lookup only: it must not hydrate. It used to be `get(...)?.docId`,
   * and the agent event stream resolves every watched key through here when
   * it opens. After a deploy every attached session reconnects at once, so
   * one reconnect loaded each watched doc from its `.ydoc`, armed its binding
   * and read its file — on staging, three sessions watching 330 docs took the
   * server from 136MB to 1.4GB and blocked the loop for 2.6s with nothing in
   * flight. The id is all any caller here wants.
   */
  const canonicalDocId = (addressed: string): string => docStore.resolveDocId(addressed);

  /**
   * The workspace to address a doc under, or null when nothing holds it.
   *
   * Deliberately `backTargetFor`'s resolution rather than
   * `taskStore.workspaceOfDoc`: a review is filed as ONE row under its review
   * id, so a member doc is never in any `docIds` and the direct lookup answers
   * null for every file in every review — which is most of the docs there are.
   * Widening `workspaceOfDoc` itself would widen SHARE SCOPING with it, and
   * that is a security decision rather than an addressing one.
   */
  const resolveWorkspaceForDoc = (docId: string): string | null =>
    backTargetFor(docId, attachmentIdOf(docStore.peekMeta(docId) ?? {}))?.id ?? null;

  /**
   * Which boards hold this member, addressed through this collection — the
   * one lookup `middleware/workspace-scope.ts` runs for every canonical
   * `/workspaces/<id>/<collection>/<memberId>` request, and therefore the one
   * place the mapping from a collection to the store that answers for it is
   * written down.
   *
   * FOUR id spaces behind seven collections, and they are genuinely not one
   * space, which is why the middleware asks with the collection rather than
   * guessing from the shape of an id:
   *
   *   goals, tasks, dispatches   a ROW, in the store's own `workspaceId`
   *                              field. A dispatch is keyed BY its task id,
   *                              so it is the same question asked of the same
   *                              row — closing a dispatch on a task another
   *                              board holds is refused by the row, and there
   *                              is no separate dispatch-to-board record for
   *                              the two to disagree about.
   *   docs, mockups, reviews     an ATTACHMENT, which is LINKED to boards and
   *                              genuinely belongs to more than one: its
   *                              review, and the board that review is filed
   *                              on. `shareWorkspacesOf` is the resolver the
   *                              share guard already reads for exactly this
   *                              question, and reading the same one here is
   *                              the point — two membership rules agree the
   *                              day they are written and the one that drifts
   *                              open is a breach.
   *   review-items               a filed ask, which has no board of its own:
   *                              it is carried by a ticket, or derived from a
   *                              doc thread. Both halves answer through the
   *                              row or the doc that carries it.
   *
   * An empty array is the answer for every id nothing holds, and the
   * middleware turns that into the same 404 an unknown board gets — a
   * separate "no such member" would tell a caller which ids are real.
   */
  const workspacesOfMember = (collection: string, memberId: string): readonly string[] => {
    switch (collection) {
      case 'goals':
      case 'tasks': {
        const row =
          taskStore.getGoalRow(memberId)?.workspaceId ?? taskStore.getTask(memberId)?.workspaceId;
        return row === undefined ? [] : [row];
      }
      case 'dispatches': {
        // A dispatch is addressed by the TASK it is on, so its board is that
        // task's board — and a dispatch whose task this store has no record of
        // (soft-deleted, or a stray id) belongs to none. `dispatchesInWorkspace`
        // already drops those from every board view for the same reason, and
        // the registry prunes a record whose worktree has gone, so nothing is
        // stranded by refusing to reach one through a board it is not on.
        const row = taskStore.getTask(memberId)?.workspaceId;
        return row === undefined ? [] : [row];
      }
      case 'docs':
      case 'mockups':
      case 'whiteboards':
      case 'apps':
      case 'attachments': {
        // The board-feedback doc belongs to EVERY board, and that is what it
        // is for: one place feedback about the product lands, reachable from
        // whichever board the person is looking at. It is filed on none of
        // them — it is minted at startup, before any board exists — so the
        // ordinary membership answer is "nowhere", which under the canonical
        // shape would make it unaddressable from the very pages that embed
        // its widget. Named here rather than by filing it on the default
        // board, because filing it there would give it exactly one address
        // and every other board's widget would 404.
        if (memberId === BOARD_FEEDBACK_DOC_ID) {
          return taskStore.listWorkspaces().map((w) => w.id);
        }
        // The two BOARD-OWNED families carry their board in the id itself
        // (`ws:<workspaceId>`, `task:<taskId>`). They are never filed as
        // attachments — the server mints them, the projection writes them —
        // so the attachment resolver below answers "nowhere" for every one
        // of them, which would 404 the board's own ydoc socket and every
        // task body. Reading the id is not trusting it: the workspace still
        // has to be the one in the path, and a `task:` id whose task this
        // store has no record of belongs to no board at all.
        if (memberId.startsWith('ws:')) {
          const owning = memberId.slice('ws:'.length);
          return taskStore.getWorkspace(owning) === undefined ? [] : [owning];
        }
        const bodyOf = taskIdOfBodyDoc(memberId);
        if (bodyOf !== null) {
          // BOTH stores, for the reason the `goals`/`tasks` case above reads
          // them both: a goal band's body doc is spelled `task:<goalId>` too —
          // one id space, two kinds of row — and asking only `getTask` here
          // 404'd every goal description (goal-parity.test.ts caught it).
          const row =
            taskStore.getTask(bodyOf)?.workspaceId ?? taskStore.getGoalRow(bodyOf)?.workspaceId;
          return row === undefined ? [] : [row];
        }
        // Through the doc store's alias table first. A caller NAMES a doc
        // (`create_review_doc('my-plan', …)`) and the server mints the id it
        // actually stores it under, so the name in the URL is very often the
        // alias rather than the canonical id — and every board link is
        // recorded against the canonical one. Asking the membership question
        // about the alias answers "nowhere", which would have made the
        // readable name the product hands out a 404 on its own board.
        //
        // `resolveDocId`, not `get`: this runs on EVERY scoped doc request,
        // before the route does, and `get` activates the binding — hydrating
        // the doc, and putting the membership check at the top of the
        // fast-lane activation table (metrics-route.test.ts caught it there).
        // The question here is only which name this one is; `resolveDocId`
        // answers it off the alias table without making anything resident.
        const canonical = docStore.resolveDocId(memberId);
        const live = shareWorkspacesOf(canonical);
        if (live.length > 0) return live;
        // ARCHIVED, and this fallback is what makes `unarchive` addressable
        // at all. Archiving unlinks the attachment from every board it was
        // on — that is the point of it, a board row pointing at something
        // that no longer loads is a dead end — so the live resolver above
        // answers nothing for exactly the ids the restore verb takes, and
        // without this every `POST …/docs/<id>/unarchive` would be refused
        // by the guard that is meant to protect it.
        //
        // The manifest is the record of where it was, written so that
        // unarchive can put it back; reading it here means "which board may
        // restore this" and "which boards does restoring it return it to"
        // are one answer rather than two that can disagree.
        const manifest =
          readDocArchiveManifest(dataDir, canonical) ?? readArchiveManifest(dataDir, canonical);
        // An ORPHAN — filed on no board and archived from none — has NO
        // address, and that is the answer rather than a gap. Its old one was
        // `/review/<id>`, which named no board and is deleted with the rest of
        // the pre-cutover paths; answering "every board" here would be
        // reinstating that compatibility under another name, and would make
        // this middleware unable to refuse for a whole class of member. The
        // 404 is the prompt to file it, which the caller has to do anyway
        // before handing the link to a person. (`BOARD_FEEDBACK_DOC_ID` above
        // is not this case: it belongs to every board by design.)
        return manifest?.linkedWorkspaces ?? [];
      }
      case 'review-items': {
        // A derived `rt-…` id encodes the doc thread it came from; a minted
        // `r-…` id is found on whichever ticket holds it. A decodable id is a
        // CLAIM — the doc it names is asked for, not assumed — which is the
        // same posture the resolve route takes on the same two families.
        const thread = parseThreadReviewItemId(memberId);
        if (thread) {
          const board = resolveWorkspaceForDoc(thread.docId);
          return board === null ? [] : [board];
        }
        const found = taskStore.findReviewItem(memberId);
        return found === undefined ? [] : [found.workspaceId];
      }
      default:
        return [];
    }
  };

  // Browser push, and the review-item quality gate that decides whether an
  // item may be announced at all. Built HERE rather than beside the other
  // stores because the gate needs `resolveWorkspaceForDoc` and the task
  // projection, and the gate takes `announceReviewItem` rather than the
  // routes calling it — so "judged, then announced" is the wiring rather
  // than a rule two callers have to remember. See review-gate.ts.
  const { pushStore, pushNotifier, announceReviewItem } = createPushAnnounce({
    dataDir,
    externalBaseUrl,
    opts,
  });
  const {
    announceTaskReview,
    announceThreadReview,
    recordedThreadHold,
    gateThreadDeclaration,
    reviseCallFor,
    judgeReviewItem,
    judgeTaskDecision,
    judgeThreadReview,
    mergedHold,
    regateDecisionWords,
    heldFields,
    askBackOnItem,
    releaseUnrevisedHold,
  } = createReviewGate({
    docStore,
    taskStore,
    taskProjection,
    sse,
    opts,
    j,
    externalBaseUrl,
    threadUrl,
    resolveWorkspaceForDoc,
    announceReviewItem,
  });

  // An open ask that stopped applying is dropped from the queue by reading
  // its thread; its asker is told once, at the moment it stopped. See
  // review-stale-notify.ts.
  const staleAsks = createStaleAskNotifier({
    thread: (docId, threadId) => docStore.getThread(docId, threadId),
    workspaceOf: resolveWorkspaceForDoc,
    titleOf: (docId) => {
      const task = docId.startsWith('task:')
        ? taskStore.getTask(docId.slice('task:'.length))
        : undefined;
      return task?.title ?? docStore.peekMeta(docId)?.title;
    },
    sendToAgent: (channel, agentId, frame) => {
      sse.sendToAgent(channel, agentId, { ...frame });
    },
  });
  const offStaleComment = docStore.onCommentPosted(staleAsks.onCommentPosted);
  const offStaleOrphan = docStore.onThreadsOrphaned(staleAsks.onThreadsOrphaned);

  /**
   * File every attachment set that predates `fileUnderBoardWorkspace` onto a
   * workspace, once per boot and never twice. See attachment-backfill.ts for
   * why this is needed and why it is safe to re-run; the short version is that
   * 20 of the 23 sets in the live data dir were created before filing existed,
   * and a set with no workspace has no address under `/workspaces/<id>/…`.
   */
  const runAttachmentBackfill = (): void => {
    const res = backfillAttachmentFiling({
      docs: () => docStore.list(),
      isFiled: (attachmentId) => taskStore.workspaceOfDoc(attachmentId) !== null,
      file: (attachmentId) => fileUnderBoardWorkspace(attachmentId),
    });
    if (res.filed.length > 0) {
      console.log(
        `[attachments] filed ${res.filed.length} previously unfiled attachment set(s) or doc(s) onto a workspace:`,
        res.filed.map((r) => `${r.attachmentId}→${r.workspaceId}`).join(', '),
      );
    }
    if (res.failed.length > 0) {
      console.error(
        `[attachments] could not file: ${res.failed.join(', ')} (will retry next boot)`,
      );
    }
  };
  runAttachmentBackfill();

  /**
   * The origin policy every CORS decision and the cross-origin write gate
   * read, plus the wrapper that stamps the headers — see
   * request-admission.ts. Composed here because `createIdentitySetup` below
   * takes `policyFor` as an input.
   */
  /**
   * The tailnet widget door (middleware/widget-door.ts): its hostnames, and
   * where a page on one sends the person to sign in. Both derived — the
   * MagicDNS name is re-read through the same 60s cache every host decision
   * uses, and the sign-in origin is the operator's own Access-fronted host.
   * No Access host means no sign-in origin, which leaves the door refusing
   * every token-bearing route rather than pointing the popup somewhere wrong.
   */
  const widgetDoorHosts = (): readonly string[] => {
    if (opts.widgetDoorHosts) return opts.widgetDoorHosts;
    const name = tailnetHostname();
    return name ? [name] : [];
  };
  const widgetSignInOrigin = proxiedTrustedHosts[0] ? `https://${proxiedTrustedHosts[0]}` : null;

  /**
   * May this person hold a board widget token for this board? Its owner (the
   * operator allowlist), or someone whose role on it lets them comment. Both
   * `BoardRole`s comment today, so a membership row of either kind — on the
   * collaboration hostname's shares or through a redeemed link — is the
   * answer; a role that could not comment would be refused here. Asked when a
   * token is minted and on every use (`boardWidgetGrantFor`), because a
   * membership can end inside the token's 24 hours.
   */
  const mayCommentOnBoard = (workspaceId: string, email: string): boolean =>
    collabMemberOf(workspaceId, email) || shareLinkMemberOf(workspaceId, email);

  /** The frame-only hostname, when configured — see frame-host.ts. */
  const frameHost = opts.frameOrigin
    ? createFrameHost({
        origin: opts.frameOrigin,
        boardHosts: opts.frameBoardHosts ?? proxiedTrustedHosts,
        keys: () => frameKeys(cookieKey()),
      })
    : null;

  const { policyFor, applyCors } = createOriginPolicy({
    opts,
    proxiedTrustedHosts,
    proxiedTrustedVerifier,
    widgetDoorHosts,
  });

  // --- Email-keyed identity --- see identity-setup.ts. The roster, the
  // sign-in stores and the four predicates that answer "who is this
  // request" — one module because a session cookie and a widget token name
  // the same session and every liveness rule has to apply to both.
  const {
    identities,
    activityLock,
    emailCodes,
    sessionRevocations,
    codeSender,
    requireEmailAuth,
    requireSignInToWrite,
    accessOnlyBrowserHosts,
    emailCodeSignIn,
    webhookReplayGuard,
    emailSessionKey,
    widgetTokenKey,
    widgetBearerOf,
    widgetTokenGrantFor,
    boardWidgetGrantFor,
    clientKeyFor,
    isSecureRequest,
    sessionIdentityFor,
    sessionSignedInAtFor,
    refreshSession,
  } = createIdentitySetup({
    dataDir,
    opts,
    cookieKey,
    setTaskStoreAgentRoster: (roster) => taskStore.setAgentRoster(roster),
    // Forward reference on purpose: `server` is bound below, and every
    // predicate here is only ever asked during a request.
    requestAddress: (req) => server.requestIP(req)?.address,
    policyFor,
    mayCommentOnBoard,
  });
  commentTrustFor = createCommentTrust({
    identityOf: (id) => identities.get(id),
    boardsForDoc,
    memberOf: audienceMemberOf,
  });
  trustBoardsFor = boardsForDoc;

  /**
   * Who may reach this server, over which hostname, and as whom — see
   * request-admission.ts. Built HERE rather than beside the origin policy
   * because `accessOnlyBrowserHosts` comes out of the identity setup just
   * above, and that setup takes `policyFor` as an input: the two halves of
   * this one subject sit on either side of it.
   */
  /** The folders each walled lead works in; every bound read, stat and
   *  write under them is re-checked against it (`board-socket-roots.ts`). */
  const boardSocketRoots = new BoardSocketRoots(boardSocketRootsPath(dataDir));
  const removeLeadBindGuard = boundFiles.guards.add(boardSocketRoots);
  /** Board agent tokens (`at2`) and their revocation record. */
  const boardAgentTokens = new BoardAgentTokens(boardTokensPath(dataDir), () =>
    boardAgentTokenKey(cookieKey()),
  );
  /** The threads those tokens opened, which the org relay checks a sender by. */
  const threadOpenerProofs = new ThreadOpenerProofs(threadOpenerProofsPath(dataDir));

  const { admit } = createRequestAdmission({
    opts,
    j,
    shares,
    sharingGate,
    boardShareTarget,
    cfAccessVerifier,
    staticAccessVerifier,
    collabAccessVerifier,
    shareLinkVerifier,
    proxiedTrustedVerifier,
    accessTunnelHosts,
    proxiedTrustedHosts,
    shareLinkHosts,
    recallCallbackHost,
    accessOnlyBrowserHosts,
    loopbackSkipsAccess: opts.loopbackSkipsAccess ?? false,
    proxiedTrustedEmails,
    // Read at request time; the notice is built further down.
    sharingOffDoor: (method, pathname) =>
      sharingOffDoorAllows(method, pathname, sharingNotice.openCard()),
    shareWorkspacesOf,
    collabMemberOf,
    shareLinkMemberOf,
    redeemShareLink,
    boardRoleOf,
    listBoards: () => taskStore.listWorkspaces(),
    safeDecodeSegment,
    withReviewUrl,
    recallRelay,
    widgetDoorHosts,
    widgetSignInOrigin,
    widgetBearerOf,
    boardWidgetGrantFor,
    docTypeOf: (docId) => docStore.peekMeta(docId)?.type,
    // Forward reference on purpose: `server` is bound below, and the peer
    // address is only ever asked during a request. Same shape, and the same
    // reason, as the identity setup's own `requestAddress` above.
    requestAddress: (req) => server.requestIP(req)?.address,
    frameHost,
    boardAgentGrantFor: (bearer) => boardAgentTokens.verify(bearer),
    boardAgentHeld: (tokenId) => boardAgentTokens.isHeld(tokenId),
    // Forward references, as above: the board sockets are opened below, and
    // the agent-token key is derived further down.
    boardOfSocket: (req) => boardSockets?.boardOf(req) ?? null,
    agentOfToken: (bearer) => verifyAgentToken(bearer, agentTokenKeyFor())?.agentId ?? null,
  });

  /**
   * What an open socket does — see socket-handlers.ts. The partner of the
   * upgrade run: that decides a socket may open and what is stamped on it,
   * this is the trio Bun calls afterwards. Composed with the other factories
   * because all three stores it reads are built above; the stores themselves
   * are passed, never anything read out of them, so every frame sees the
   * state as it is when the frame arrives.
   */
  // A mock's or app's own voice and ears, on the spoken reply's engines
  // (`app-voice/`). Its token's key is derived from the cookie key, so a
  // restart keeps the tokens in open frames valid.
  const appVoiceKey = () => appVoiceTokenKey(cookieKey());
  const mintAppVoice = (workspaceId: string, docId: string, at?: number) =>
    mintAppVoiceToken(appVoiceKey(), workspaceId, docId, at);
  const appVoiceSeed = (workspaceId: string, docId: string) => ({
    socket: appVoiceSocketPath(workspaceId, docId),
    ...mintAppVoice(workspaceId, docId),
  });
  const appVoiceRelay = new AppVoiceRelay({
    engines: spokenEngines,
    sayFor: appSayer(docStore),
    mint: (workspaceId, docId) => mintAppVoice(workspaceId, docId),
    // CW_APP_VOICE_DAILY_LISTEN_S and CW_APP_VOICE_DAILY_SPEAK_CHARS (`limits.ts`).
    limits: appVoiceLimitsFromEnv(process.env),
  });

  const socketHandlers = createSocketHandlers({
    docStore,
    meetingRelay,
    recallRelay,
    voiceRelay,
    spokenRelay,
    appVoiceRelay,
    onBoardRoomOpen: (workspaceId, awareness) => agentSpots.restore(workspaceId, awareness),
  });

  /**
   * Whose name goes on a write — see request-attribution.ts. Composed
   * directly below admission because that is the order the two RUN in: the
   * gate proves who the boundary saw, and attribution ranks those proofs
   * against what the body claims. It is the one member of this split that
   * chains rather than composes — its per-request input is the admission
   * result, so it cannot be called until the gate has answered.
   */
  const { attributeRequest } = createRequestAttribution({
    identities,
    taskStore,
    sessionIdentityFor,
    widgetBearerOf,
    widgetTokenGrantFor,
    j,
  });

  /**
   * Which page or asset an address gets — see routes/shell-static.ts. Composed
   * HERE rather than beside the other helpers because `emailCodeSignIn`
   * comes out of the identity setup just above, and the landing page's
   * counter comes out of the Home pane above that.
   */
  const { serveShellRoutes } = createShellStatic({
    widgetDist,
    markdownAppDist,
    demosDir,
    dataDir,
    docStore,
    taskStore,
    browserSentry,
    frameHost,
    emailCodeSignIn,
    j,
    isValidDocId,
    redirectTo,
    withReviewUrl,
    // The retired boards' task docs too: the page's own activity reading
    // walks every board, and it runs after this in the same stretch.
    landingReview: async () => {
      await crossReview.prepare({ includeRetired: true });
      const q = await crossReview.queue();
      // Fire and forget: the page shows what is stored, and a sentence that
      // arrives now is on the next load. Each refresh declines unless due.
      for (const p of q.projects) void boardSummaries.refresh({ id: p.workspaceId, name: p.name });
      return {
        items: q.items,
        rankOf: new Map(q.projects.map((p) => [p.workspaceId, p.rank])),
        summaryOf: (id) => boardSummaries.read(id),
        goals: planGoals(q.planWorkspaceId).map((g) => ({ id: g.id, title: g.title })),
        ...(q.planWorkspaceId ? { planWorkspaceId: q.planWorkspaceId } : {}),
      };
    },
    defaultBoardWorkspaceName: DEFAULT_BOARD_WORKSPACE_NAME,
    // Started further down, with the other registered features; the page
    // reads it at request time.
    landingInbox: (rankOf) => features.inbox.landingSection(rankOf),
    landingCoach: () => coachWiring.landing(),
    landingRemote: () => (homeRemotes ? renderRemoteReview(homeRemotes.boards()) : ''),
    appVoiceSeed,
  });

  /** This server's side of Home across servers — see routes/home-feed.ts. */
  const homeFeedCtx: HomeFeedRoutesContext = {
    sse,
    boardName: (id) => taskStore.getWorkspace(id)?.name,
    feed: async (id) => {
      await crossReview.prepare();
      const { items } = await crossReview.queue();
      return homeFeedOf(id, taskStore.getWorkspace(id)?.name ?? id, items);
    },
    verifier: staticAccessVerifier,
    clientId: opts.homeFeedClientId,
    peerAddress: (req) => server.requestIP(req)?.address ?? undefined,
    j,
  };

  /** GitHub events for boards that hold no GitHub token — routes/github-hub.ts. */
  const githubHubCtx: GithubHubRoutesContext = {
    hub: new GithubHub(githubHubPath(dataDir), () => githubPushKeyKey(cookieKey())),
    boardExists: (id) => taskStore.getWorkspace(id) !== undefined,
    caller: homeFeedCtx,
    deliver: (boardId, frame) => {
      let reached = 0;
      for (const agentId of sse.agentsOn(`ws~${boardId}`)) {
        reached += sse.sendToAgent(`ws~${boardId}`, agentId, { ...frame });
      }
      return reached;
    },
    j,
    safeJson,
  };

  /**
   * The requests that end in a connection rather than a body — see
   * routes/upgrade-stream.ts. Composed HERE because `requireSignInToWrite` comes out
   * of the identity setup above and `policyFor` out of the origin policy
   * above that; everything else it reads is a store built with the rest.
   *
   * `server` is a forward reference, the same shape `requestAddress` uses two
   * blocks down: `Bun.serve` has not returned yet, and it is narrowed to
   * `upgrade` so this module can take a connection over and nothing else.
   */
  /**
   * The agent-stream proof, shared by the three routes that speak it: the
   * mint, the durable watch set, and the multiplexed stream. Derived lazily
   * from the one key file, cached like every other protocol key here.
   */
  let agentTokenKeyCache: string | null = null;
  const agentTokenKeyFor = (): string => {
    agentTokenKeyCache ??= deriveAgentTokenKey(cookieKey());
    return agentTokenKeyCache;
  };
  const requireAgentToken = opts.requireAgentToken ?? false;
  /** One warning per agent id per route for the whole process life. */
  const warnLegacyAgentCaller = createLegacyAgentWarner();
  const warnRefusedMint = createRefusedMintWarner();
  const identifyAgentCaller = (req: Request) => {
    const peer = server.requestIP(req);
    if (!peer) return Promise.resolve({ ok: false as const, reason: 'no peer socket' });
    return (opts.identifyAgentCaller ?? identifyCallerAgent)(peer, server.port ?? 0);
  };

  const { serveUpgradeAndStreamRoutes } = createUpgradeStream({
    server: { upgrade: (req, options) => server.upgrade(req, options) },
    docStore,
    taskStore,
    sse,
    agentWatches,
    watchKeyExists,
    recallRelay,
    policyFor,
    requireSignInToWrite,
    isValidDocId,
    canonicalDocId,
    fileUnderBoardWorkspace,
    workspacesOfMember,
    j,
    requestAddress: (req) => server.requestIP(req)?.address,
    agentTokenKey: agentTokenKeyFor,
    requireAgentToken,
    warnLegacyAgentCaller,
    appVoiceToken: (token, workspaceId, docId) =>
      checkAppVoiceToken(appVoiceKey(), token, workspaceId, docId),
    frameOrigin: frameHost?.origin ?? null,
    // The lead hears every board on this machine; a stream off it gets no
    // ask from a local-only board or doc (ask-feed.ts).
    offBoxView: (payload) =>
      offBoxAskView(
        payload,
        (ask) =>
          localOnlyPlaces.board(ask.workspaceId) ||
          (ask.row.kind !== 'task-review' && localOnlyPlaces.doc(ask.row.docId)),
      ),
  });
  /**
   * What the operator routes read instead of this closure's scope. Built
   * once — every collaborator in it is long-lived.
   */
  const opsRoutesCtx: OpsRoutesContext = {
    docStore,
    pluginRefresher,
    deployer,
    pushStore,
    pushNotifier,
    webhookLog,
    // The note-taker's week, walked per request. One window for every
    // reader, so the health check and a person curling the route are looking
    // at the same claim.
    notesQualityRollup: () =>
      rollupNotesQuality(dataDir, { now: Date.now(), windowMs: NOTES_QUALITY_WINDOW_MS }),
    // A week of blocking answers off the ledger, per request like the above.
    blockingWait: () => {
      const now = Date.now();
      return blockingWait(crossReview.ledger.read(now - BLOCKING_WAIT_WINDOW_MS), now);
    },
    // The OTHER claim `GET /api/deploy` answers: not "did the last deploy
    // come up" but "is this process bound and discoverable, now". Both halves
    // are read per request — `Bun.serve` has not returned when this object is
    // built, and the discovery slot can change hands under a running server.
    liveness: () =>
      describeLiveness({
        boundPort: boundAt === null ? null : (server.port ?? port),
        boundAt,
        pid: process.pid,
        discovery: readDiscoveryEntry(),
      }),
    j,
    safeJson,
    requestAddress: (req) => server.requestIP(req)?.address,
  };

  // Open pages hear that a REST-fed list they drew is stale: the Library,
  // members, a review's sidebar, the voice page and the prompts settings
  // (page-nudges.ts). Wired after the stall wiring, whose `onAgentStreams`
  // is a plain assignment this chains onto.
  const pageNudges = wirePageNudges({
    nudger: createPageNudger({
      send: (channel, frame) => sse.broadcastTransient(channel, frame, { skipAgentStreams: true }),
    }),
    docStore,
    taskStore,
    // A task's or a board's own doc is never a Library row.
    boardsHolding: (docId) =>
      docId.startsWith('task:') || docId.startsWith('ws:') ? [] : [...boardsForDoc(docId)],
    shareLinks,
    sse,
  });

  /** The words this server's prompts run on — the settings page's data. */
  const promptRoutesCtx: PromptRoutesContext = {
    promptStore,
    j,
    safeJson,
    stream: () => openSseStream(sse, PROMPTS_CHANNEL),
    onWritten: pageNudges.promptsChanged,
  };

  // An open review follows its folder on disk while a page holds its stream
  // (folder-watch.ts); the refresh's own `onSetRescanned` nudges the page.
  const folderWatches = createFolderWatches({
    sourceOf: (setId) => liveSourceOf(docStore.list(), setId),
    refresh: (setId) => docStore.refreshWorkspace(setId),
  });
  const unwatchStreams = sse.watchStreams((channel) => {
    if (channel.startsWith('ws~')) folderWatches.sync(channel.slice(3), sse.pagesOn(channel));
  });

  /** The cross-board review queue and its wait report — trusted-local only. */
  const reviewQueueRoutesCtx: ReviewQueueRoutesContext = {
    crossReview,
    boardName: (id) => taskStore.getWorkspace(id)?.name,
    sizePrefs: new ReviewSizePrefs(dataDir),
    ranks: leadRanks.ranks,
    onRanked: landingChanges.notify,
    refuseNonLocal: (req) => refuseNonLocalAgentCaller(req, server.requestIP(req)?.address),
    leadOf: (workspaceId) => taskStore.getWorkspace(workspaceId)?.leadAgentId,
    planGoalIds: (workspaceId) => planGoals(workspaceId).map((g) => g.id),
    // The rank is held to the lead's token always, like an inbox post.
    authorizeAgent: (req, agentId) =>
      authorizeAgentCaller({
        agentId,
        req,
        address: server.requestIP(req)?.address,
        key: agentTokenKeyFor(),
        requireToken: true,
      }),
    sessionIdentityId: (req) => sessionIdentityFor(req)?.id ?? null,
    renderPage: () => renderReviewsShell(browserSentry, readAppAssetManifest(markdownAppDist)),
    pageHeaders: HTML_SHELL_HEADERS,
    j,
    safeJson,
  };

  /** The voice page and its agent list — the owner's alone (routes/voice-page.ts). */
  const ownerVoiceAgents = () =>
    voiceAgentList({
      boards: () =>
        taskStore
          .listWorkspaces()
          .filter((w) => !isRetired(w))
          .map((w) => ({
            id: w.id,
            name: w.name,
            ...(w.leadAgentId ? { leadAgentId: w.leadAgentId } : {}),
          })),
      attachments: (ws) => taskStore.listAttachments(ws),
      displayName: (id) => identities.displayNameFor(id) ?? undefined,
    });
  const voicePageRoutesCtx: VoicePageRoutesContext = {
    agents: ownerVoiceAgents,
    renderPage: () => renderVoiceShell(browserSentry, readAppAssetManifest(markdownAppDist)),
    pageHeaders: HTML_SHELL_HEADERS,
    stream: () => openSseStream(sse, VOICE_CHANNEL),
    j,
  };
  /** The voice conversation API: OpenAI chat over a voice token (routes/voice-api.ts). */
  const voiceApiRoutesCtx: VoiceApiRoutesContext = {
    chat: new VoiceChat(
      workspacesVoiceAgents({
        boards: ownerVoiceAgents,
        line: voiceAgentLine,
        leads: leadAnswers,
        newId: () => cryptoId('vt'),
      }),
    ),
    tokens: new VoiceApiTokens(voiceTokensPath(dataDir), () => voiceApiTokenKey(cookieKey())),
    speakerName: (subject) =>
      identities.displayNameFor(subject) ?? ownerDisplayNames()[0] ?? 'The owner',
    mintSubject: () => ownerIdentityIds()[0] ?? 'owner',
    j,
  };

  // The registered features (routes/features.ts): each family's stores, its
  // routes at the position Incoming Messages held in the chain, and its stop.
  // Started HERE, where the inbox's route context was built — the first
  // family moved behind them, and the last of its readers to exist.
  const features = startServerFeatures({
    dataDir,
    opts,
    taskStore,
    identities,
    notifyLanding: (part) => landingChanges.notify(part),
    requestAddress: (req) => server.requestIP(req)?.address,
    agentTokenKey: agentTokenKeyFor,
    j,
    safeJson,
  });

  /** The coach's pages, stream and the session's moments (routes/coach.ts). */
  const coachRoutesCtx: CoachRoutesContext = {
    wiring: coachWiring,
    boardExists: (workspaceId) => taskStore.getWorkspace(workspaceId) !== undefined,
    docOnBoard: (workspaceId, docId) =>
      docId.startsWith('task:')
        ? taskStore.getTask(docId.slice(5))?.workspaceId === workspaceId
        : (taskStore.getWorkspace(workspaceId)?.docIds ?? []).includes(docId),
    refuseNonLocal: (req) => refuseNonLocalAgentCaller(req, server.requestIP(req)?.address),
    j,
    safeJson,
  };

  /**
   * The repo registry — checkouts of a project, and which copy of a doc is
   * live. Loopback-only, for the same reason the deploy route is: every value
   * it hands back is a path on this machine.
   */
  const repoRoutesCtx: RepoRoutesContext = {
    docStore,
    j,
    safeJson,
    requestAddress: (req) => server.requestIP(req)?.address,
  };

  /**
   * Mounted project folders — the lead's mount table and the address every
   * file in it answers at. Built on the doc store's repo registry, because a
   * mounted file's address is derived the same way a document's identity is:
   * the repo plus the path from its root.
   */
  const mountStore = new MountStore(dataDir, docStore.repos);
  /**
   * Which attachment sets keep their files on this machine
   * (`attachment-privacy.ts`). One gate reads it for every address that
   * reaches into a set, right after admission and above the upgrades, so a
   * local-only set's file, file list, socket and stream are refused to every
   * caller that is not on the box by the same line.
   */
  const attachmentPrivacy = new AttachmentPrivacyStore(dataDir);
  const setOfDoc = (docId: string): string | undefined => {
    const meta = docStore.peekMeta(docStore.resolveDocId(docId));
    return meta ? (meta.setId ?? meta.workspaceId) : undefined;
  };
  const localOnlyGate = {
    isLocalOnlySet: (setId: string) => attachmentPrivacy.isLocalOnly(setId),
    setOfDoc,
    docOfReviewItem: (itemId: string) => parseThreadReviewItemId(itemId)?.docId,
  };
  const docWithheldFrom = (req: Request, docId: string): boolean =>
    attachmentPrivacy.isLocalOnly(setOfDoc(docId)) &&
    !isOnBox(req.headers, server.requestIP(req)?.address ?? undefined);
  const mountRoutesCtx: MountRoutesContext = {
    mounts: mountStore,
    j,
    safeJson,
    requestAddress: (req) => server.requestIP(req)?.address,
  };

  // A reader opened a project file: what a run's output item waits on.
  const noteOpened = (ws: string, relPath: string): void =>
    noteOutputOpened(taskStore, ws, relPath, SCHEDULER_ACTOR, (m) => console.error(m));
  /** The board's Library — its meetings and its project's files, and the
   *  verb that opens a project file nobody has bound yet. */
  const libraryRoutesCtx: LibraryRoutesContext = {
    docStore,
    taskStore,
    taskProjection,
    mounts: mountStore,
    dataDir,
    j,
    safeJson,
    unfileFromDefault,
    markdownFiles: createMarkdownLister(),
    requestAddress: (req) => server.requestIP(req)?.address,
    isLocalOnlySet: (setId) => attachmentPrivacy.isLocalOnly(setId),
    onOpened: noteOpened,
  };
  const libraryOutputSource = () =>
    libraryRunOutputSource(libraryRoutesCtx, (id) => taskStore.getWorkspace(id));
  runOutputSource = libraryOutputSource;
  // The doc page's open of the file a doc holds, and what its dock offers.
  const pageOpened = (ws: string, docId: string, owner: boolean) => {
    // The project walk is paid only on a board with a run's item standing.
    const waiting = taskStore.listTasks(ws).some((t) => t.schedule?.state?.output?.item);
    const relPath = waiting ? libraryOutputSource().fileOf(ws, docId) : undefined;
    if (relPath !== undefined) noteOpened(ws, relPath);
    const readable = relPath === undefined ? undefined : itemsLinking(taskStore, ws, relPath);
    return boardLinkedItems(ws, docId, taskStore, docStore, readable, owner);
  };

  /** The migration verb: one board doc into its project's folder, same doc. */
  const docMoveRoutesCtx: DocMoveRoutesContext = {
    docStore,
    mounts: mountStore,
    dataDir,
    isRecording: (docId) => meetingStore.active(docId) !== undefined,
    j,
    safeJson,
    isValidDocId,
  };

  /**
   * Where a board's meetings file: its project, and what that project chose.
   *
   * The project is read the same way the Library reads it — the repo holding
   * most of this board's own docs — rather than stored beside the board,
   * because a board has no repo field and a second answer to "which project
   * is this" is a second answer that can drift from the first.
   */
  const meetingHomeFor = (workspaceId: string): MeetingHomeResolution | null => {
    const board = taskStore.getWorkspace(workspaceId);
    if (!board) return null;
    const ids = new Set(board.docIds);
    const repoKey = projectRepoKey(
      docStore.list().filter((m) => ids.has(m.docId)),
      (docId) => docStore.repos.primaryKeyFor(docId),
    );
    if (!repoKey) return null;
    const home = mountStore.meetingHome(repoKey);
    return home ? { repoKey, ...home } : null;
  };

  /**
   * What a board's project has mounted, for the attach answer.
   *
   * The project is resolved exactly as `meetingHomeFor` above resolves it —
   * the repo most of the board's own docs sit in — so the two answers cannot
   * name different projects for the same board.
   */
  const mountsBriefFor = (workspaceId: string, req: Request): AttachMountsBrief => {
    const board = taskStore.getWorkspace(workspaceId);
    const ids = new Set(board?.docIds ?? []);
    const repoKey = board
      ? projectRepoKey(
          docStore.list().filter((m) => ids.has(m.docId)),
          (docId) => docStore.repos.primaryKeyFor(docId),
        )
      : null;
    if (!repoKey) return attachMountsBrief({ repoKey: null, folders: [], mayNameFolders: true });
    // A local-only project's file NAMES stop at the edge with its bytes.
    const onBox =
      !req.headers.has('cf-ray') && isLoopbackAddress(server.requestIP(req)?.address ?? undefined);
    return attachMountsBrief({
      repoKey,
      folders: mountStore.registry.liveMounts(repoKey).map((m) => m.relPath),
      mayNameFolders: onBox || mountStore.privacyOf(repoKey) !== 'local-only',
    });
  };

  /** A review's own files — thread roll-up, grouped diff, tree, lazy opens. */
  const reviewFileRoutesCtx: ReviewFileRoutesContext = { docStore, j, safeJson };

  /** The chat-audit counters — one store, read and written by two routes. */
  const chatAuditRoutesCtx: ChatAuditRoutesContext = { chatAudit, j, safeJson };

  /** Recall's signed webhook — bot status changes and calendar sync events,
   *  which arrive on the same endpoint because webhooks are workspace-level
   *  at the vendor. */
  const recallWebhookRoutesCtx: RecallWebhookRoutesContext = {
    recallRelay,
    calendarSync,
    webhookReplayGuard,
    meetingBotWebhookSecret: opts.meetingBotWebhookSecret,
    j,
  };

  /** Setup 4's custom-LLM route — armed only while the agent is built. */
  const voiceAgentLlmRoutesCtx: VoiceAgentLlmRoutesContext = {
    callbacks: agentCallbacks,
    llmSecret: opts.spokenReply?.agent?.llmSecret ?? null,
    j,
  };

  /** The archive family — the four archive/unarchive routes and the
   *  review-only delete the board delete two positions below still calls. */
  const archiveRoutesCtx: ArchiveRoutesContext = {
    docStore,
    taskStore,
    taskProjection,
    dataDir,
    j,
    safeJson,
    unlinkFromEveryBoardWorkspace,
    canonicalDocId,
  };
  const { handleArchiveRoutes } = createArchiveRoutes(archiveRoutesCtx);

  /**
   * The hosted MCP connector — see connector/host.ts. Each agent it hosts
   * reads its event stream in-process, through the same function
   * `/events/agent/<id>` answers with, and calls REST over loopback like the
   * stdio child did, so every REST gate sees what it always saw.
   */
  /** Whether a watch key is on one board: the board, one of its tasks, or a doc it holds. */
  const watchKeyOnBoard = (key: string, boardId: string): boolean => {
    if (key === `ws:${boardId}`) return true;
    if (key.startsWith('task:')) {
      return taskStore.getTask(key.slice('task:'.length))?.workspaceId === boardId;
    }
    return shareWorkspacesOf(key).includes(boardId);
  };
  const connectorHost = createConnectorHost({
    createSession: hostedSessionFactory({
      baseUrl: () => `http://127.0.0.1:${server.port}`,
      // A session opened on a board's socket reads only that board's keys.
      openAgentEvents: (agentId, lastEventId, boardId) =>
        openAgentMuxStream({
          bus: sse,
          agentId,
          keys: () =>
            agentWatches
              .list(agentId, watchKeyExists)
              .watches.map((w) => w.key)
              .filter((key) => boardId === undefined || watchKeyOnBoard(key, boardId)),
          channelFor: (key) => channelForWatchKey(key, canonicalDocId),
          cursors: parseMuxCursor(lastEventId ?? undefined),
          onWatchSetChanged: (cb) => agentWatches.onChange(agentId, cb),
        }),
      // Hosted sessions mint in-process: their REST calls come from this
      // process, which the loopback mint refuses (auth/agent-caller.ts). The
      // identity is the one `/mcp`'s own gate already settled: it took that
      // agent's token to get in.
      mintAgentToken: (agentId) => mintAgentToken(agentId, agentTokenKeyFor()),
      // A board socket session's REST calls carry a board token kept here,
      // never handed to the lead (connector/board-token-lease.ts).
      boardToken: (agentId, boardId) =>
        boardTokenLease(boardAgentTokens, agentId, boardId, (line) => console.error(line)),
      log: (...args) => console.error('[connector]', ...args),
    }),
    fallbackPluginVersion: () => readReleasedPluginVersion() ?? '0.0.0',
    log: (...args) => console.error(...args),
  });

  /** What the two agent-id-keyed routes read instead of this closure's
   *  scope — the watch set, the roster and the store a merge moves. */
  const agentIdentityRoutesCtx: AgentIdentityRoutesContext = {
    agentWatches,
    identities,
    taskStore,
    j,
    safeJson,
    requestAddress: (req) => server.requestIP(req)?.address,
    watchKeyExists,
    watchCoverageFor,
    canonicalDocId,
    watchKeyOnBoard,
    agentTokenKey: agentTokenKeyFor,
    requireAgentToken,
    warnLegacyAgentCaller,
    identifyAgentCaller,
    warnRefusedMint,
  };

  /** The board agent token's mint, list and revoke (routes/board-tokens.ts). */
  const boardTokenRoutesCtx: BoardTokenRoutesContext = {
    tokens: boardAgentTokens,
    boardExists: (boardId) => taskStore.getWorkspace(boardId) !== undefined,
    ensureAgent: (agentId) => {
      const rec = identities.get(agentId) ?? identities.upsertAgent(agentId);
      return rec !== null && rec.kind === 'agent';
    },
    closeConnections: (memberKey) =>
      docStore.closeSocketsForShareMembers((k) => k === memberKey) +
      sse.closeForShareMembers((k) => k === memberKey),
    j,
    safeJson,
    requestAddress: (req) => server.requestIP(req)?.address,
  };
  /** The folders each board's walled lead can write (routes/board-socket-roots.ts). */
  const boardSocketRootsRoutesCtx: BoardSocketRootsRoutesContext = {
    roots: boardSocketRoots,
    boardExists: boardTokenRoutesCtx.boardExists,
    j,
    safeJson,
    requestAddress: boardTokenRoutesCtx.requestAddress,
  };

  /**
   * What the meeting, transcript and calendar routes read instead of this
   * closure's scope. Built once — every collaborator in it is long-lived.
   */
  const meetingCalendarRoutesCtx: MeetingCalendarRoutesContext = {
    docStore,
    taskStore,
    meetingStore,
    meetingRelay,
    recallRelay,
    calendarStore,
    calendarSync,
    calendarBot: opts.calendarBot,
    featuresOff: opts.featuresOff ?? {},
    calendarOauthStates,
    dataDir,
    j,
    isValidDocId,
    fileUnderBoardWorkspace,
  };

  /** What the attached-app routes read — see ./routes/apps.ts. */
  const appRoutesCtx: AppRoutesContext = {
    docStore,
    j,
    safeJson,
    isValidDocId,
    fileUnderBoardWorkspace,
    withReviewUrl,
    widgetDist,
    markdownAppDist,
    browserSentry,
    ownPort: () => server.port ?? port,
    appOutages: new AppOutages({
      leadOf: (workspaceId) => taskStore.getWorkspace(workspaceId)?.leadAgentId,
      send: (workspaceId, agentId, frame) =>
        sse.sendToAgent(`ws~${workspaceId}`, agentId, { ...frame }),
    }),
    agentName: (agentId) => identities.displayNameFor(agentId) ?? undefined,
    frameHost,
    appVoiceSeed,
  };

  /**
   * What the doc, thread and bind routes read instead of this closure's
   * scope. Built once — every collaborator in it is long-lived.
   */
  const docRoutesCtx: DocRoutesContext = {
    agentSpots,
    leadWritable: (boardId, path) => {
      const c = boardSocketRoots.containedOf(path);
      return c !== null && boardSocketRoots.rootFor(boardId, c.root) !== null;
    },
    boardIsShared,
    docStore,
    taskStore,
    taskProjection,
    webhooks,
    leadPresence,
    readyNudger,
    ...(opts.answerCoverage ? { answerCoverage: opts.answerCoverage } : {}),
    threadRequestDedup,
    threadOpenerProofs,
    summarizer,
    dataDir,
    j,
    safeJson,
    ANONYMOUS_ACTOR,
    isValidDocId,
    canonicalDocId,
    backTargetFor,
    resolveWorkspaceForDoc,
    pageOpened,
    withReviewUrl,
    boardIndexForListing,
    boardsForDocIndexed,
    homeForDocIndexed,
    fileUnderBoardWorkspace,
    unlinkFromEveryBoardWorkspace,
    threadUrl,
    fileReviewRequest,
    judgeThreadReview,
    announceThreadReview,
    recordedThreadHold,
    gateThreadDeclaration,
    heldFields,
    rewriteTaskBody,
    parseRevisedRange,
    workspacesOfDoc: shareWorkspacesOf,
  };

  // The owner's notice when the master sharing switch goes off: one decision
  // on the catch-all board, filed by the server and judged like any other
  // item (sharing-notice.ts). Its "Turn back on" answer flips the switch
  // through the route's own path, below.
  const sharingNoticeActor = {
    id: SHARING_NOTICE_ACTOR.id,
    name: SHARING_NOTICE_ACTOR.name,
    kind: SHARING_NOTICE_ACTOR.kind,
  };
  const sharingNotice = new SharingNotice({
    dataDir,
    boardId: defaultBoardWorkspaceId,
    isBoardLive: (workspaceId) => {
      const w = taskStore.getWorkspace(workspaceId);
      return w !== undefined && !isRetired(w);
    },
    fallbackBoards: () =>
      rankFallbackBoards(
        taskStore.listWorkspaces().map((w) => ({
          id: w.id,
          retired: isRetired(w),
          shared: boardIsShared(w.id),
          activeAt: lastBoardActivityAt(w, taskStore.listTasks(w.id)),
        })),
      ),
    getTask: (taskId) => taskStore.getTask(taskId),
    createTask: (workspaceId, taskOpts) => taskStore.createTask(workspaceId, taskOpts),
    addAccessReviewItem: (taskId, change, why, o) =>
      taskStore.addAccessReviewItem(taskId, change, why, o),
    withdrawReviewItem: (taskId, itemId, o) => taskStore.withdrawReviewItem(taskId, itemId, o),
    refresh: (taskId) => {
      const task = taskStore.getTask(taskId);
      if (task) taskProjection.refreshTask(task);
    },
    gate: async (taskId, itemId) => {
      const task = taskStore.getTask(taskId);
      const item = taskStore.listReviewItems(taskId).find((i) => i.id === itemId);
      if (!task || !item) return;
      const verdict = await judgeReviewItem(task, item, sharingNoticeActor);
      if (verdict.held) {
        console.error(
          `[sharing] owner notice held by the review gate item=${itemId}: ${verdict.reason}`,
        );
        // Filed whatever the gate says (the lead's decision, 23 September):
        // the gate exists to hold agent-written asks, this card is a fixed
        // template, and a security notice the owner never sees is worse than
        // one the gate dislikes. A held item is off the owner's queue, so the
        // hold is recorded as passed, with the gate's words kept beside it.
        const reason = verdict.reason ?? '';
        taskStore.recordReviewJudgement(
          taskId,
          itemId,
          {
            at: Date.now(),
            verdict: 'ok',
            reason: `Filed by the server whatever the gate says. The gate held it: ${reason}`,
            heldFor: [reason],
          },
          { actor: sharingNoticeActor },
        );
        taskProjection.refreshTask(taskStore.getTask(taskId) ?? task);
      }
      const stored = taskStore.listReviewItems(taskId).find((i) => i.id === itemId);
      announceTaskReview(taskStore.getTask(taskId) ?? task, stored ?? verdict.item, {
        id: sharingNoticeActor.id,
        name: sharingNoticeActor.name,
        kind: 'known',
        color: ANONYMOUS_ACTOR.color,
      });
    },
  });
  /** The owner approved the notice's card at the access door. */
  const turnSharingOnFromCard = (by: string): { ok: boolean; error?: string } =>
    sharingNotice.turnOnFromCard(() => {
      const res = applyMasterFlip(
        {
          docStore,
          sse,
          shares,
          sharingGate,
          onSharingFlip: (flip) => void sharingNotice.onFlip(flip),
        },
        {
          enabled: true,
          actor: `owner ${by}`,
          peer: 'the access door',
          reason: 'approved the sharing notice',
          at: Date.now(),
        },
      );
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    });

  // An agent's share call that would let somebody new in files a proposal;
  // only the owner's Approve applies it (share/access-proposals.ts).
  const accessProposals = new AccessProposals({
    taskStore,
    shareLinks,
    shareLinkBaseHost,
    isBoardLocked: (workspaceId) => sharingGate.isBoardLocked(workspaceId),
    setBoardEnabled: (workspaceId) => sharingGate.setBoardEnabled(workspaceId, true),
    setBoardUnlocked: (workspaceId) => sharingGate.setBoardLocked(workspaceId, false),
    setSharingOn: turnSharingOnFromCard,
    announce: (task, item, author) => {
      taskProjection.refreshTask(task);
      announceTaskReview(task, item, author);
    },
    onChanged: pageNudges.accessChanged,
  });
  /** The owner's page of who can reach every board (routes/access.ts). */
  const accessRoutesCtx: AccessRoutesContext = {
    view: () =>
      buildAccessView({
        boards: taskStore.listWorkspaces(),
        shareLinks,
        proposals: (ids) => accessProposals.rows(ids),
      }),
    renderPage: () => renderAccessShell(browserSentry, readAppAssetManifest(markdownAppDist)),
    pageHeaders: HTML_SHELL_HEADERS,
    stream: () => openSseStream(sse, ACCESS_CHANNEL),
    sharingOff: () => {
      const open = sharingNotice.openCard();
      const item = open
        ? taskStore.listReviewItems(open.taskId).find((r) => r.id === open.itemId)
        : undefined;
      const review = item?.review as { headline?: unknown; detail?: unknown } | undefined;
      return {
        enabled: sharingGate.isEnabled(),
        ...(open && item && item.answer === undefined && item.access !== undefined
          ? {
              card: {
                path: sharingOffCardPath(open),
                change: item.access,
                headline: typeof review?.headline === 'string' ? review.headline : '',
                detail: typeof review?.detail === 'string' ? review.detail : '',
              },
            }
          : {}),
      };
    },
    j,
  };

  /**
   * What the sign-in, session and share routes read instead of this closure's
   * scope. Built once — every collaborator in it is long-lived.
   */
  const authShareRoutesCtx: AuthShareRoutesContext = {
    docStore,
    sse,
    taskStore,
    shares,
    shareLinks,
    accessProposals,
    shareLinkBaseHost,
    collabMemberOf,
    sharingGate,
    requestAddress: (req) => server.requestIP(req)?.address,
    onSharingFlip: (flip) => void sharingNotice.onFlip(flip),
    identities,
    emailCodes,
    sessionRevocations,
    codeSender,
    requireEmailAuth,
    requireSignInToWrite,
    emailCodeSignIn,
    defaultBoardWorkspaceName: DEFAULT_BOARD_WORKSPACE_NAME,
    // The operator allowlist doubles as the audience a `share_link` with no
    // `allowDomains` admits. Same list, same source; see the field's doc.
    defaultShareAudience: [...proxiedTrustedEmails],
    j,
    safeJson,
    clientKeyFor,
    emailSessionKey,
    widgetTokenKey,
    widgetDoorHosts,
    mayCommentOnBoard,
    isSecureRequest,
    policyFor,
    sessionIdentityFor,
  };

  /**
   * What the task routes read instead of this closure's scope. Built once —
   * every collaborator in it is long-lived — and handed to the handlers with
   * the per-request half (the URL, the visitor, the author) alongside.
   */
  const taskRoutesCtx: TaskRoutesContext = {
    // Carried through only when the caller supplied one: an explicit
    // `undefined` and an absent key read the same to the route, and the route
    // answers 503 for both, but leaving the key out keeps "nothing wired one"
    // legible in a debugger.
    ...(opts.secretWriter ? { secretWriter: opts.secretWriter } : {}),
    ...(permissionGrants ? { permissionGrants } : {}),
    accessProposals,
    ...(opts.answerCoverage ? { answerCoverage: opts.answerCoverage } : {}),
    taskStore,
    taskProjection,
    docStore,
    dispatches,
    dispatchReports,
    agentNotes,
    agentNoteLog,
    chatAudit,
    isCoachSession: (workspaceId, agentName) => coachWiring.isCoachSession(workspaceId, agentName),
    coachSessionTurn: (workspaceId, note, cwd) => {
      coachWiring.sessionTurn(workspaceId, note, cwd);
    },
    coachSessionPrompt: (workspaceId, mark, cwd) => {
      coachWiring.sessionPrompt(workspaceId, mark, cwd);
    },
    leadChatMirror: leadChat,
    leadSessionMirror,
    readyNudger,
    j,
    safeJson,
    ANONYMOUS_ACTOR,
    parseRevisedRange,
    announceTaskReview,
    askBackOnItem,
    boardIndexForListing,
    heldFields,
    holdersClause,
    boardsForDocIndexed,
    externalBaseUrl,
    judgeReviewItem,
    judgeTaskDecision,
    mergedHold,
    parallelismCapView,
    proposeAllowRule,
    regateDecisionWords,
    rewriteTaskBody,
    workspacesOfDoc: shareWorkspacesOf,
  };
  /**
   * The same split for the workspace routes — see ./routes/workspaces.ts.
   * Built once, for the same reason: every collaborator in it is long-lived,
   * and the per-request half travels with each call.
   */
  // Every board load report is judged against the two-second list-paint
  // budget on its way into the log, and a slow one is raised where somebody
  // is watching. Through `captureServerError` rather than a second capture
  // path, so the alarm groups, scrubs and ships exactly like every other
  // server-side event — the sentry-claude-channel plugin is what turns it
  // into a message an agent receives.
  const slowLoadAlarm = new SlowLoadAlarm((message, extra) =>
    captureServerError(new Error(message), extra),
  );
  // Every page's judged loads, one server-wide log, so the daily health
  // check can read the slowest per page type (`routes/load-reports.ts`).
  const pageLoads = new PageLoadLog(dataDir);
  const loadReportRoutesCtx: LoadReportRoutesContext = {
    pageLoads,
    slowLoadAlarm,
    j,
    safeJson,
    requestAddress: (req) => server.requestIP(req)?.address,
  };
  // The loop watchdog and the register it reads.
  //
  // `SlowLoadAlarm` above judges how long a BOARD took to load, as the browser
  // reports it; this judges whether the server was running anything at all.
  // The 16 September episodes were invisible to the first and would have been
  // one line each to the second, because the requests that came back late were
  // 401s and 404s — nothing about them is slow except the queue they sat in.
  const inflight = new InflightRegistry();
  const loopLag = new LoopLagMonitor({
    thresholdMs: opts.loopBlockThresholdMs ?? undefined,
    inflight: () => inflight.snapshot(),
  });
  const workspaceRoutesCtx: WorkspaceRoutesContext = {
    leadBindRoot: (boardId, folderPath) => boardSocketRoots.rootFor(boardId, folderPath),
    chatAudit,
    shareLinks,
    accessProposals,
    taskStore,
    taskProjection,
    docStore,
    sse,
    homeBriefs,
    agentWatches,
    voiceRouter,
    spokenRelay,
    spokenTimings,
    leadChat,
    leadChatMeetings,
    featuresOff: opts.featuresOff ?? {},
    authorizeAgent: (req, agentId) =>
      authorizeAgentCaller({
        agentId,
        req,
        address: server.requestIP(req)?.address,
        key: agentTokenKeyFor(),
        requireToken: requireAgentToken,
      }),
    dataDir,
    clientReleaseRootDir,
    opts,
    j,
    safeJson,
    isValidDocId,
    externalBaseUrl,
    withReviewUrl,
    homePayload,
    reviewItemsFor,
    parallelismCapView,
    slowLoadAlarm,
    pageLoads,
    resolveWorkspaceForDoc,
    boardsForDoc,
    fileUnderBoardWorkspace,
    unfileFromDefault,
    workspacesOfDoc: shareWorkspacesOf,
    watchKeyExists,
    keepMovingVerdicts: stallWiring.keepMoving,
    meetingHomeFor,
    mountsBriefFor,
    attachmentPrivacy,
    docWithheldFrom,
    onBoardPromptsChanged: pageNudges.promptsChanged,
  };

  /**
   * The front door: everything every request passes through, whatever
   * address it named.
   *
   * Lifted out of the `fetch` option so the `routes` table below and the
   * fallback can be the SAME handler. A route in the table and a route that
   * falls through therefore cannot diverge: both run this, and this runs the
   * ordered chain in `route()` unchanged. The table decides nothing about
   * dispatch on purpose — see `routes/route-table.ts` for why the chain, not
   * Bun’s specificity matching, still orders the eight adjacencies whose
   * comments call them load-bearing.
   */
  // Loopback TCP from a refused user (a project machine's lead) is answered
  // here, before any check that trusts a loopback peer reads it.
  const refuseLoopbackUid = loopbackUidDoor(opts.loopbackRefusedUids ?? [], opts.peerUid);

  /** The device and location a browser request's analytics rows carry, in
   *  scope for exactly as long as the request is (event-origin.ts). */
  function handleWithOrigin(req: Request): Promise<Response | undefined> {
    const refusedCaller = refuseLoopbackUid(server.requestIP(req), server.port ?? 0);
    if (refusedCaller) return Promise.resolve(j(403, { error: refusedCaller }));
    const origin = originOfHeaders(req.headers, isBrowserRequest(req.headers));
    // Registered HERE rather than inside `handleRequest`, which has several
    // early returns and a hoisted inner `route` declaration that a wrapping
    // try/finally would move out of function scope. This wrapper is the one
    // place every request passes through exactly once — the route table and
    // the fallback both call it — so one `finally` cannot leak an entry, not
    // even for an upgrade that answers `undefined`.
    const settled = inflight.enter(req);
    return withEventOrigin(origin, () => handleRequest(req)).finally(settled);
  }

  // The ordered chain every request runs — see routes/request-chain.ts. Built
  // last, from every route family's context above; it reads nothing per
  // request but the request.
  const handleRequest = createRequestChain({
    docStore,
    applyCors,
    refreshSession,
    slowRequestMs,
    policyFor,
    isValidDocId,
    j,
    requestAddress: (req) => server.requestIP(req)?.address,
    homeFeedCtx,
    githubHubCtx,
    admit,
    localOnlyGate,
    attributeRequest,
    requireSignInToWrite,
    freshSignInGate: (req, pathname, admitted, widgetIdentity) =>
      refuseStaleSignIn(
        req,
        pathname,
        personProofOf(admitted, sessionIdentityFor(req), sessionSignedInAtFor(req), widgetIdentity),
        { shares, now: Date.now() },
      ),
    authShareRoutesCtx,
    voiceAgentLlmRoutesCtx,
    recallWebhookRoutesCtx,
    serveUpgradeAndStreamRoutes,
    taskStore,
    workspacesOfMember,
    opsRoutesCtx,
    docRoutesCtx,
    appRoutesCtx,
    workspaceRoutesCtx,
    taskRoutesCtx,
    connectorHost,
    // Forward reference: the board sockets are opened below.
    boardOfSocket: (req) => boardSockets?.boardOf(req) ?? null,
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
    promptRoutesCtx,
    sse,
    reviewQueueRoutesCtx,
    voicePageRoutesCtx,
    accessRoutesCtx,
    voiceApiRoutesCtx,
    featureRoutes: features.routes,
    coachRoutesCtx,
    serveShellRoutes,
  });

  const server = Bun.serve<UpgradeData>({
    port,
    // Unset means Bun's own default (every interface) — unchanged for every
    // caller but `scripts/staging.ts`, which is the only one that passes a
    // value. See `ServerOptions.hostname` above for why.
    ...(hostname ? { hostname } : {}),
    // Explicit because the DEFAULT is what broke the event streams: Bun's is
    // 10 seconds, the SSE keepalive ran on 20, and so every stream idled out
    // before its own guard could write. Paired with `SSE_KEEPALIVE_MS` and
    // asserted against it in `sse-keepalive.test.ts` — the two numbers only
    // mean anything together. Bun throws above 255.
    //
    // This governs HTTP connections. Websockets take `websocket.idleTimeout`
    // (default 120s) and Bun pings them itself, which is why the `/y/*`
    // editing sockets were never affected — measured idle-surviving 30s on
    // the unfixed build, while SSE died at 9.7s.
    idleTimeout: opts.httpIdleTimeoutSec ?? HTTP_IDLE_TIMEOUT_SEC,
    // `server` is gone from this signature and from `route`'s: the three
    // websocket upgrades were the only things in the route table that read
    // it, and they now reach it through the narrowed forward reference the
    // upgrade-stream factory holds. Bun still passes it; nothing here wants
    // it.
    // ── The route table ── see routes/route-table.ts.
    //
    // Every front-door path pattern this server answers, each registered
    // through `gated(...)` naming the gate it sits behind. Mounting it here
    // is what makes it a runtime value rather than a document: the drift
    // test reads the same object Bun dispatches on, so a pattern that leaves
    // the table leaves the server’s own registry with it.
    //
    // Every entry’s handler IS `handleRequest`, and an address the table
    // does not name reaches the same function through `fetch` below. That is
    // deliberate: Bun matches by specificity, and this router’s order is
    // behaviour in eight documented places (the Recall status webhook above
    // the `/recall/` upgrade, meetings above the doc catch-all, and the rest
    // named in `route-table.ts`). Handing dispatch to a matcher that does not
    // know those adjacencies would change what a request is answered by.
    routes: mountRouteTable(ROUTE_TABLE, handleWithOrigin),
    async fetch(req) {
      return handleWithOrigin(req);
    },
    // ── Socket handlers ── see socket-handlers.ts. A19 decided the socket
    // may open and what is stamped on it; this is what Bun calls for the
    // life of that connection. `close` is synchronous on purpose — the
    // drain in `stop` below fires it inside `server.stop(true)`, while the
    // stores its writes land in are still up.
    websocket: socketHandlers,
  });

  // One socket per live board (board-sockets.ts), only when asked for:
  // bin.ts passes the folder when `--board-socket-dir`, `CW_BOARD_SOCKET_DIR`
  // or `CW_BOARD_SOCKETS=1` says so (server-config.ts). Kept in step with the boards as they are made, archived and deleted.
  const boardSockets = opts.boardSocketDir
    ? openBoardSockets({
        dir: opts.boardSocketDir,
        handle: handleWithOrigin,
        j,
        // Shared only with a group to share it with: never with every user.
        ...(opts.boardSocketShared && opts.boardSocketGroup !== undefined
          ? { shared: { board: opts.boardSocketShared, gid: opts.boardSocketGroup } }
          : {}),
      })
    : null;
  const syncBoardSockets = () =>
    boardSockets?.sync(
      taskStore
        .listWorkspaces()
        .filter((w) => w.retiredAt === undefined)
        .map((w) => w.id),
    );
  syncBoardSockets();
  const unwatchBoardList = taskStore.onWorkspaceListChanged(syncBoardSockets);

  // The port is bound. Stamped HERE rather than at the top of `createServer`
  // because `Bun.serve` THROWS on a taken port and `bin.ts` retries on
  // another — a server that never reached this line is one no request can
  // reach either, and `liveness.ok` has to say so.
  boundAt = Date.now();

  // Every agent the previous process was hosting is subscribed again HERE:
  // after the port is bound (so a server that loses the port race and is
  // thrown away subscribes nobody) and before this function returns, so no
  // request — and no broadcast a request causes — can run first. Each
  // subscription registers on the bus synchronously; see
  // connector/session-factory.ts. What the snapshot holds: connector/snapshot.ts.
  connectorHost.restore(loadConnectorSnapshot(dataDir));

  // The effort re-scoring pass starts HERE, after the port is bound, not
  // where it is defined. `createServer` THROWS when the port is taken, and
  // `bin.ts` answers by constructing a whole new server on the next port —
  // so a pass kicked off during construction runs once for every attempt,
  // from stores belonging to servers nobody kept, all writing the same data
  // directory. Observed on a dev box where 8788 was already held: two passes
  // over the same 99 rows, and the abandoned one still calling the API.
  // Reaching this line is what makes a server real.
  void rescoreStaleEffortEstimates();
  // Bound, so the remote streams open for the server that was kept.
  homeRemotes?.start();
  // The old clock titles are renamed here for the same reason: once, by the
  // server that was kept, never blocking the boot it follows.
  void retitleClockTitlesAtBoot(docStore, opts.meetingNotes?.titleNamer ?? null);

  /**
   * The base every human-facing URL this server emits is built on.
   *
   * One function, so the operator override cannot reach some links and miss
   * others. That is not hypothetical tidiness: the links are the deliverable
   * of a TLS deploy — a `reviewUrl` still pointing at `http://<host>:<port>`
   * sends the reader back to the origin the deploy existed to leave, where
   * the browser refuses the microphone. Missing one call site would look
   * entirely fine until someone pressed the mic on that particular link.
   *
   * A function rather than a captured constant because `server.port` is only
   * known after `Bun.serve` resolves port 0.
   */
  function externalBaseUrl(): string {
    return opts.publicBaseUrl ?? publicBaseUrl(server.port ?? port);
  }

  /**
   * The link an agent hands over after posting a report — the URL that opens
   * where the thread now lives.
   *
   * Measured cost of not having it: 52,340 words — 40% of every word in the
   * user's chat window over 38 hours — were agent-to-agent reports relayed
   * through his terminal rather than posted on the task they belonged to.
   * The rule to post on the task already ships. What did not exist was a
   * cheap way to then TELL a peer where it went: the write succeeded and
   * returned no link, so handing over a pointer meant assembling one from
   * parts against a base URL the agent may not know — while answering in
   * chat cost nothing. This is the same fix `reviewGapAdvice` makes for a
   * thin review item: what the author needs next travels back on the success
   * response, rather than being something they are expected to know.
   *
   * Absolute, unlike `taskDeepLink`'s own relative output, and that
   * difference is the point: the brief renders on the page it points at, but
   * this URL is being pasted somewhere else entirely. It goes through
   * `externalBaseUrl()` for the reason that function exists — one base, so
   * an operator override cannot reach some links and miss others.
   *
   * Covers BOTH surfaces a thread can live on, and the second one is not a
   * nicety: the thread that asked you for something is very often a comment
   * on a markdown attachment, not a task. A version of this that answered
   * only for `task:` docs would hand back nothing on the commonest reply
   * path — reintroducing, one surface over, exactly the friction the whole
   * change exists to remove.
   *
   * OWNER ONLY, and deliberately more conservative than today's sharing
   * needs. Per-doc shares were removed (`POST /api/share/link` answers 410
   * `per_doc_sharing_removed`), so every visitor that can reach this code is
   * workspace-scoped and already holds the id this would tell them — the
   * guard closes no leak that is currently open. It stays because the value
   * is a URL capability and the cost of keeping it owner-only is nil, so the
   * default should already be right on the day doc-scoped visitors come
   * back. Returns undefined for an unknown doc, so callers can spread it.
   */
  function threadUrl(docId: string, isVisitor: boolean): string | undefined {
    if (isVisitor) return undefined;
    if (docId.startsWith('task:')) {
      const workspaceId = taskStore.workspaceOfDoc(docId);
      if (!workspaceId) return undefined;
      const taskId = docId.slice('task:'.length);
      return `${externalBaseUrl()}${taskDeepLink(workspaceId, taskId)}`;
    }
    // Reuse `withReviewUrl` rather than rebuild the doc path here: it already
    // branches on doc type (a mockup answers under `mockups/`, not `docs/`)
    // and it resolves the board the doc is on, which the address now needs.
    // One builder, the same reason `externalBaseUrl` is one function.
    const meta = docStore.peekMeta(docId);
    return meta ? withReviewUrl(meta).reviewUrl : undefined;
  }

  // Decorate doc metadata with a `reviewUrl` that's actually reachable from
  // other devices on the tailnet / LAN. Markdown docs render at
  // /workspaces/<ws>/docs/<docId>; mockup docs bound to a file on disk render
  // at /workspaces/<ws>/mockups/<docId> — same one-call-one-URL contract as
  // markdown. Both need the BOARD, which is why this resolves one: a doc id
  // on its own stopped being an address in the canonical-routes cutover, so a
  // doc no board holds gets no URL, exactly like a mockup without a sourceUrl
  // (e.g. dev-server surfaces hosted elsewhere) — there's nothing to serve.
  function withReviewUrl<T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
    /**
     * The doc's board, when the caller already knows it. A LISTING knows it:
     * it resolves every row's board from one shared index (see
     * `homeForDocIndexed`) instead of paying `resolveWorkspaceForDoc`'s
     * per-row scan. `undefined` means "not supplied" and keeps the original
     * behaviour; `null` is a real answer meaning no board holds this doc, so
     * the two cannot be collapsed.
     */
    precomputedHome?: string | null,
  ): T & { reviewUrl?: string } {
    const base = externalBaseUrl();
    // The ONE place a resource URL is minted, which is why the whole fleet's
    // addresses move with this function. A doc is addressed under the board
    // holding it, and there is no other address: `/review/<id>` and
    // `/mockup/<id>` are gone, so a doc no board holds gets NO `reviewUrl`
    // rather than a link that 404s. That silence is the useful answer — it
    // says "file this on a board before you hand it to anyone", which is the
    // thing the caller has to do, where a legacy URL let them skip it and
    // find out later in front of the reviewer.
    const home =
      precomputedHome !== undefined ? precomputedHome : resolveWorkspaceForDoc(meta.docId);
    if (!home) return meta;
    const ws = `${base}/workspaces/${encodeURIComponent(home)}`;
    const id = encodeURIComponent(meta.docId);
    // A whiteboard has content but not the doc editor: it has its own page.
    if (meta.type === 'whiteboard') return { ...meta, reviewUrl: `${ws}/whiteboards/${id}` };
    if (contentKind(meta.type) !== 'none') {
      // Every doc kind with server-held content (markdown/code/diff) shares
      // the SPA route; the app branches the editor on the doc's type at boot.
      return { ...meta, reviewUrl: `${ws}/docs/${id}` };
    }
    if (meta.type === 'mockup' && meta.sourceUrl) {
      return { ...meta, reviewUrl: `${ws}/mockups/${id}` };
    }
    if (meta.type === 'app' && meta.sourceUrl) {
      return { ...meta, reviewUrl: `${ws}/apps/${id}/` };
    }
    return meta;
  }

  // A share can also lapse without anyone revoking it. Revocation hangs up
  // immediately (see DELETE /api/share/:id); expiry has no such moment, so
  // sweep. 60s means a lapsed visitor keeps their socket for at most a
  // minute — HTTP already refuses them the whole time, so nothing new is
  // reachable, they just haven't been hung up on yet.
  const SHARE_SWEEP_MS = 60_000;
  /** Exactly what the interval does, named so tests drive the real thing
   *  rather than a re-implementation of it. */
  const sweepDeadShares = (): void => {
    // A tailnet widget door socket is authorized once at its upgrade too, by
    // a board token that expires and that the roster can revoke — and no
    // share is needed for the door, so this half runs without one.
    docStore.closeSocketsForDeadWidgetGrants(
      (token, origin) => boardWidgetGrantFor(token, origin) !== null,
    );
    if (!shares) return;
    const isLive = (id: string) => shares.findLive(id) !== null;
    docStore.closeSocketsForDeadShares(isLive);
    // Websockets aren't the only long-lived grant — an SSE stream is
    // authorized once at open too, and would otherwise keep delivering
    // comments to a visitor whose share has lapsed.
    sse.closeForDeadShares(isLive);
    // A collaboration-hostname visitor carries no shareId — no one share
    // admitted them — so a lapsed share is found by asking their membership
    // again, the question DELETE /api/share/:id asks when one is revoked.
    const ended = collabMembershipEnded(collabMemberOf);
    docStore.closeSocketsForShareMembers(ended);
    sse.closeForShareMembers(ended);
  };
  // Armed whatever is configured: the widget door's hostname can be discovered
  // after boot (`tailnetHostname` in public-host.ts re-asks Tailscale), and a door socket
  // admitted then still needs this sweep. A pass with nothing open costs a
  // walk over no sockets.
  const shareSweep = setInterval(() => {
    try {
      sweepDeadShares();
    } catch {
      // A sweep failure must never take the server down with it.
    }
  }, SHARE_SWEEP_MS);
  // Never hold the process (or a test runner) open.
  shareSweep.unref?.();

  // Armed here rather than in bin.ts, because the wake is a property of a
  // running board and not of the production deployment — a staging server
  // or an embedded one should behave the same way. `start` unrefs its own
  // timer, so this can never keep a process alive.
  readyNudger.start();
  stallNudger.start();
  taskScheduler.start(opts.schedulerTickMs ?? undefined);

  // The loop watchdog. Armed with every other running-board timer and for the
  // same reason: a staging server wedges exactly like prod does, and the whole
  // value of this line is being in the log the incident is read from. `start`
  // unrefs, so it cannot hold a process open.
  loopLag.start();

  // Done-when lines already marked for the owner before their review items
  // existed get one each. Idempotent by construction — a line with an open
  // item gets nothing — so every start runs it and a second start files none.
  // What it filed or revised goes through the quality gate like any filing,
  // fired without awaiting: a board must come up while a judge is slow.
  try {
    const owner = taskStore.syncOwnerItemsEverywhere();
    if (owner.filed + owner.withdrawn + owner.revised > 0) {
      console.log(
        `[tasks] owner done-when lines: filed ${owner.filed} review item(s), withdrew ${owner.withdrawn}, revised ${owner.revised}`,
      );
    }
    void (async () => {
      for (const { taskId, reviewItemIds } of owner.toJudge) {
        await gateOwnerItems(taskId, reviewItemIds, undefined, {
          getTask: (id) => taskStore.getTask(id),
          judgeReviewItem,
          announceTaskReview,
        });
      }
    })().catch((err) => console.error('[tasks] judging owner done-when items failed:', err));
  } catch (err) {
    console.error('[tasks] owner done-when review items failed:', err);
  }

  // Rows still carrying the removed `parked` state come onto the new spelling
  // for it here — triage, plus a comment holding the date and the reason. See
  // park-migration.ts for why the comment is written before the fields are
  // cleared, and why that makes the pass idempotent.
  //
  // Fired without awaiting and with its own catch: a board that cannot write
  // one comment must still come up. Nothing downstream reads its result, and
  // an unmigrated row simply stays parked until the next start.
  const parkMigration = migrateParkedRows({
    store: taskStore,
    note: (fields, from) =>
      parkNoteText({
        ...(fields.parkedUntil !== undefined ? { until: fields.parkedUntil } : {}),
        ...(fields.parkedReason !== undefined ? { reason: fields.parkedReason } : {}),
        ...(from !== 'triage' ? { from } : {}),
        migrated: true,
      }),
    comment: async (task, text) => {
      taskProjection.ensureTaskBody(task);
      const posted = await docStore.postComment(
        taskBodyDocId(task.id),
        null,
        { ...PARK_MIGRATION_ACTOR, kind: 'known' } as unknown as User,
        text,
        { kind: 'subject' },
        { generate: false },
      );
      return posted !== null;
    },
  })
    .then((res) => {
      if (res.migrated.length > 0) {
        console.log(`[tasks] parked → triage: migrated ${res.migrated.length} row(s)`);
      }
      for (const s of res.skipped) {
        console.error(`[tasks] parked → triage: left ${s.taskId} alone — ${s.reason}`);
      }
      return res;
    })
    .catch((err): ParkMigrationResult => {
      console.error('[tasks] parked → triage migration failed:', err);
      return { migrated: [], skipped: [] };
    });

  return {
    connector: connectorHost,
    port: server.port ?? port,
    docStore,
    tasks: taskStore,
    projection: taskProjection,
    agentWatches,
    chatAudit,
    identities,
    dispatches,
    dispatchReports,
    folderWatches,
    shares,
    shareLinks,
    sweepDeadShares,
    appVoice: { mint: mintAppVoice },
    // Exactly what the interval does, exposed for the same reason
    // `sweepDeadShares` is: a test drives the real thing rather than a
    // re-implementation of it.
    // The startup pass that moved rows off the removed `parked` state, so a
    // test can await the real thing instead of racing it.
    parkMigration,
    nudgeReadyWork: () => readyNudger.tick(),
    // Same contract as `nudgeReadyWork`: a test drives the real loop rather
    // than a re-implementation of what it is believed to do.
    nudgeStalls: () => stallNudger.tick(),
    nudgeStallsTimed: () => stallNudger.timedTick(),
    // Same contract again: a test drives the real scheduler pass and reads
    // back what it fired, rather than re-implementing the loop.
    runScheduler: () => taskScheduler.tick(),
    readyNudgeTally: () => readyNudger.tally(),
    sharingGate,
    webhookLog,
    stop: async () => {
      clearInterval(shareSweep);
      // Release before anything else can fail: a lock left behind by a clean
      // shutdown would make the next repair refuse for no reason. It is
      // reclaimed as stale on a crash either way, but only after a pid check
      // somebody has to trust.
      releaseActivityLock(activityLock);
      // Before anything else that tears state down: a tick mid-shutdown
      // would read a store that is being flushed and wake a lead about a
      // server that is going away.
      readyNudger.stop();
      stallNudger.stop();
      // `unref` keeps the monitor from holding the process open; it does NOT
      // stop the interval firing. The server suite builds many servers in one
      // process, so a closed server that kept ticking would hold a closure
      // onto its dead registry and write `[loop]` lines into unrelated tests'
      // output for the rest of the run.
      loopLag.stop();
      taskScheduler.stop();
      features.stop();
      landingChanges.dispose();
      homeRemotes?.dispose();
      pageNudges.dispose();
      unwatchStreams();
      folderWatches.dispose();
      coachWiring.stop();
      leadPresence.stop();
      // The boot re-scoring pass runs for as long as there are stale rows, so
      // a short-lived server (every test) can still be mid-loop here. Setting
      // the flag is enough: the loop checks it either side of each call, so
      // it stops before the next write rather than being torn out mid-write.
      stopEffortRescore();
      // Close the worktree watchers with the loop that read them; the
      // persisted dispatch set survives for the next process to re-arm.
      dispatches.stop();
      uptimeMonitor.stop();
      // The sockets come down HERE, not at the end. `stop(true)` force-closes
      // every open connection instead of leaving keep-alive HTTP and
      // websockets to drain — without it each server this process ever
      // started keeps its sockets to the grave (measured 2026-08-30: +733
      // kernel PCBs per server-suite run, and a machine-wide ENOBUFS at the
      // end of a night of them).
      //
      // Force-closing fires every `close(ws)` handler SYNCHRONOUSLY inside
      // this call, and those handlers write: a meeting's flushes its last
      // sentence into the doc. So they have to run while the subsystems
      // below are still live — after `docStore.flush()` that write would have
      // nowhere left to land.
      server.stop(true);
      unwatchBoardList();
      removeLeadBindGuard();
      boardSockets?.stop();
      // Who the connector was hosting, for the next process to subscribe
      // before its first request; then its subscriptions come down with the
      // sockets that carried them.
      try {
        saveConnectorSnapshot(dataDir, connectorHost.snapshot());
      } catch (err) {
        console.error('[connector] could not save the identity snapshot:', err);
      }
      connectorHost.stop();
      // AFTER the sockets, never before: the force-close above fired every
      // stream's close handler synchronously, and each one arms a held
      // departure. Stopping earlier would leave exactly those timers behind
      // to outlive the bus they were going to broadcast on.
      stallWiring.stopListeningAnnouncer();
      // Close the books on any live meeting, so a restart never finds a doc
      // marked as recording by a socket that died with the process. Awaited
      // because the close handlers above start their teardowns async, and
      // their notes belong in the docs this flushes next.
      crossReview.dispose();
      offStaleComment();
      offStaleOrphan();
      leadRanks.stop();
      // The microphone relay, voice feedback and the bots, in that order —
      // see meeting-wiring.ts.
      await meetings.dispose();
      // Flush pending body snapshots into the store BEFORE the store's own
      // flush, so the last keystrokes in a task body reach the sidecar.
      taskProjection.stop();
      // Flush pending sidecar writes so a clean shutdown never loses board
      // state that was still inside the debounce window.
      taskStore.stop();
      // Same contract for the docs themselves: run the docs' pending 200ms
      // .ydoc saves and ~800ms bound-file write-backs. SIGTERM reaches here
      // via bin.ts, and before this call it lost exactly as much just-typed
      // content as SIGKILL (measured 0/100 kept on a burst killed 103ms
      // after the last keystroke, on both signals).
      // Stop the sweeps BEFORE flushing: an eviction landing mid-flush would
      // drop a doc the flush is about to write.
      docStore.stop();
      docStore.flush();
      // Hand the next process each channel's final event id. Without it every
      // subscriber's cursor is unrecognisable after the restart and every
      // stream opens with a `replay.gap` that has nothing behind it.
      saveReplayMarks(dataDir, sse.marks());
    },
  };
}

function isValidDocId(s: string): boolean {
  // Allow a reasonable set of URL-safe chars. Disallow leading dot so IDs
  // can't masquerade as hidden files on disk. Length cap protects the
  // filename from being pathological. `~` is permitted because workspace
  // member docIds encode the relPath's `/` separators as `~`
  // (`${workspaceId}:${relPath.replaceAll('/', '~')}` in doc-store.ts), so any
  // file in a subdirectory of a bound folder needs `~` to be reachable via
  // the /api/docs/:docId routes. `~` is RFC 3986 unreserved (URL-safe) and a
  // valid filename char, matching the .ydoc-on-disk naming.
  if (!s || s.startsWith('.')) return false;
  return /^[a-zA-Z0-9_.:~\-]{1,100}$/.test(s);
}

function j(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    // CORS is added by the per-request wrapper in createServer, which knows
    // the Origin. This used to stamp a wildcard `*` origin on every reply.
    headers: { 'content-type': 'application/json' },
  });
}

// The canonical embed loads the widget bundle from this server but runs the
// host page on a different origin (e.g. an Astro dev server on a different
// port). Every REST call from the widget is therefore cross-origin and needs
// CORS. The widget posts comments without credentials (auth is via the
// request body's `author` field, not cookies), so `*` is safe and avoids
// the per-request-Origin echo dance.
async function safeJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
