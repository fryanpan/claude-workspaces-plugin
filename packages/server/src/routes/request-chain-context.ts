/**
 * The request chain's shared vocabulary: every long-lived value the ordered
 * chain reads (`RequestChainContext`), and what one admitted request carries
 * from the gates in `request-chain.ts` into the two halves below them
 * (`ChainRequest`).
 *
 * `createServer` builds the context once, after every route family's own
 * context exists. Nothing in it is per request; the request and what the
 * gates proved about it travel as `ChainRequest`.
 */
import type { addressesLocalOnlySet } from '../attachment-privacy.ts';
import type { ConnectorHost } from '../connector/host.ts';
import type { DocStore } from '../doc-store.ts';
import type { FeatureRoutes } from '../feature-module.ts';
import type { OriginPolicy } from '../middleware/browser-origin.ts';
import type { WorkspaceScope } from '../middleware/workspace-scope.ts';
import type { RequestAdmission } from '../request-admission.ts';
import type {
  AttributableRequest,
  Attribution,
  RequestAttribution,
} from '../request-attribution.ts';
import type { SseBus } from '../sse.ts';
import type { BoardWorkspace, TaskStore } from '../tasks.ts';
import type { AgentIdentityRoutesContext } from './agent-identity.ts';
import type { AppRoutesContext } from './apps.ts';
import type { createArchiveRoutes } from './archive.ts';
import type { AuthShareRoutesContext } from './auth-share.ts';
import type { BoardTokenRoutesContext } from './board-tokens.ts';
import type { ChatAuditRoutesContext } from './chat-audit-routes.ts';
import type { CoachRoutesContext } from './coach.ts';
import type { DocMoveRoutesContext } from './doc-move.ts';
import type { DocRoutesContext } from './docs-routes-context.ts';
import type { GithubHubRoutesContext } from './github-hub.ts';
import type { HomeFeedRoutesContext } from './home-feed.ts';
import type { LoadReportRoutesContext } from './load-reports.ts';
import type { MeetingCalendarRoutesContext } from './meetings-calendar.ts';
import type { MountRoutesContext } from './mounts.ts';
import type { OpsRoutesContext } from './ops.ts';
import type { PromptRoutesContext } from './prompts.ts';
import type { RecallWebhookRoutesContext } from './recall-webhook.ts';
import type { RepoRoutesContext } from './repos.ts';
import type { ReviewFileRoutesContext } from './review-files.ts';
import type { ReviewQueueRoutesContext } from './review-queue.ts';
import type { ShellStatic } from './shell-static.ts';
import type { TaskRoutesContext } from './tasks.ts';
import type { UpgradeStream } from './upgrade-stream.ts';
import type { VoiceAgentLlmRoutesContext } from './voice-agent-llm.ts';
import type { VoiceApiRoutesContext } from './voice-api.ts';
import type { VoicePageRoutesContext } from './voice-page.ts';
import type { LibraryRoutesContext } from './workspace-library.ts';
import type { WorkspaceRoutesContext } from './workspaces.ts';

export interface RequestChainContext {
  // ── The front door ──
  docStore: DocStore;
  /** CORS headers for the request's origin, stamped on the way out. */
  applyCors: (req: Request, res: Response) => Response;
  /** The sliding session cookie, renewed on the way out. */
  refreshSession: (req: Request, res: Response) => Response;
  /** A request slower than this is logged with its path and status. */
  slowRequestMs: number;
  policyFor: (req: Request) => OriginPolicy;
  isValidDocId: (s: string) => boolean;
  j: (status: number, body: unknown) => Response;
  /** The peer address a request arrived from, when Bun knows it. */
  requestAddress: (req: Request) => string | undefined;

  // ── The gates, in chain order ──
  homeFeedCtx: HomeFeedRoutesContext;
  githubHubCtx: GithubHubRoutesContext;
  admit: RequestAdmission['admit'];
  localOnlyGate: Parameters<typeof addressesLocalOnlySet>[1];
  attributeRequest: RequestAttribution['attributeRequest'];
  requireSignInToWrite: boolean;
  authShareRoutesCtx: AuthShareRoutesContext;
  voiceAgentLlmRoutesCtx: VoiceAgentLlmRoutesContext;
  recallWebhookRoutesCtx: RecallWebhookRoutesContext;
  serveUpgradeAndStreamRoutes: UpgradeStream['serveUpgradeAndStreamRoutes'];
  taskStore: TaskStore;
  workspacesOfMember: (collection: string, memberId: string) => readonly string[];

  // ── The board and REST families (`request-chain-board.ts`) ──
  opsRoutesCtx: OpsRoutesContext;
  docRoutesCtx: DocRoutesContext;
  appRoutesCtx: AppRoutesContext;
  workspaceRoutesCtx: WorkspaceRoutesContext;
  taskRoutesCtx: TaskRoutesContext;
  connectorHost: ConnectorHost;
  agentTokenKeyFor: () => string;
  agentIdentityRoutesCtx: AgentIdentityRoutesContext;
  boardTokenRoutesCtx: BoardTokenRoutesContext;
  chatAuditRoutesCtx: ChatAuditRoutesContext;
  repoRoutesCtx: RepoRoutesContext;
  loadReportRoutesCtx: LoadReportRoutesContext;
  mountRoutesCtx: MountRoutesContext;
  libraryRoutesCtx: LibraryRoutesContext;
  docMoveRoutesCtx: DocMoveRoutesContext;
  handleArchiveRoutes: ReturnType<typeof createArchiveRoutes>['handleArchiveRoutes'];
  reviewFileRoutesCtx: ReviewFileRoutesContext;
  meetingCalendarRoutesCtx: MeetingCalendarRoutesContext;

  // ── The top-level families and the tail (`request-chain-tail.ts`) ──
  promptRoutesCtx: PromptRoutesContext;
  sse: SseBus;
  reviewQueueRoutesCtx: ReviewQueueRoutesContext;
  voicePageRoutesCtx: VoicePageRoutesContext;
  voiceApiRoutesCtx: VoiceApiRoutesContext;
  /** Every registered feature's routes (`features.ts`), tried at the
   *  position the inbox routes held. */
  featureRoutes: FeatureRoutes;
  coachRoutesCtx: CoachRoutesContext;
  serveShellRoutes: ShellStatic['serveShellRoutes'];
}

/**
 * One request the gates admitted and attributed, with the workspace scope
 * they resolved. The two halves below the gates read their per-request
 * values off this rather than re-deriving any of them.
 */
export interface ChainRequest {
  req: Request;
  url: URL;
  pathname: string;
  scope: WorkspaceScope<BoardWorkspace> | undefined;
  gate: AttributableRequest;
  attribution: Extract<Attribution, { attributed: true }>;
  /** A person proof naming the owner — never a body, a widget token or an
   *  agent token. */
  ownerProven: () => boolean;
  /** Whether a mock's or app's frame served on this request carries an app
   *  voice token (`app-voice/gate.ts`). */
  mayMintAppVoice: () => boolean;
}
