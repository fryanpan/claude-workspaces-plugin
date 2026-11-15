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
import type { DocStore } from '../doc-store.ts';
import type { FeatureRoutes } from '../feature-module.ts';
import type { HonoBoardEnv } from '../hono-env.ts';
import type { IdentityRecord } from '../identities.ts';
import type { OriginPolicy } from '../middleware/browser-origin.ts';
import type { WorkspaceScope } from '../middleware/workspace-scope.ts';
import type { RequestAdmission } from '../request-admission.ts';
import type {
  AttributableRequest,
  Attribution,
  RequestAttribution,
} from '../request-attribution.ts';
import type { BoardWorkspace, TaskStore } from '../tasks.ts';
import type { BoardImportRoutesContext } from './board-import.ts';
import type { BoardLinkRoutesContext } from './board-links.ts';
import type { GithubHubRoutesContext } from './github-hub.ts';
import type { HomeFeedRoutesContext } from './home-feed.ts';
import type { HonoFront } from './hono-front.ts';
import type { ShellStatic } from './shell-static.ts';
import type { UpgradeStream } from './upgrade-stream.ts';

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
  boardImportCtx: BoardImportRoutesContext;
  githubHubCtx: GithubHubRoutesContext;
  admit: RequestAdmission['admit'];
  localOnlyGate: Parameters<typeof addressesLocalOnlySet>[1];
  attributeRequest: RequestAttribution['attributeRequest'];
  requireSignInToWrite: boolean;
  /** The fresh-sign-in refusal for a person's counted action, or null
   *  (`fresh-signin.ts`). */
  freshSignInGate: (
    req: Request,
    pathname: string,
    admitted: AttributableRequest,
    widgetIdentity: IdentityRecord | null,
  ) => Promise<Response | null>;
  /** The Hono app (`hono-front.ts`) with the families it answers
   *  (`hono-families.ts`), tried below the gates and above every family the
   *  chain still holds. */
  honoFront: HonoFront;
  serveUpgradeAndStreamRoutes: UpgradeStream['serveUpgradeAndStreamRoutes'];
  taskStore: TaskStore;
  workspacesOfMember: (collection: string, memberId: string) => readonly string[];

  // ── The board families ──
  /** The board app (`hono-front.ts`) with the families it answers
   *  (`hono-board-families.ts`), tried below the workspace scope with the
   *  scope in its env, and above the top-level families and the tail. */
  honoBoardFront: HonoFront<HonoBoardEnv>;

  // ── The top-level families and the tail (`request-chain-tail.ts`) ──
  /** Every registered feature's routes (`features.ts`), tried at the
   *  position the inbox routes held. */
  featureRoutes: FeatureRoutes;
  serveShellRoutes: ShellStatic['serveShellRoutes'];
  /** The wrong-form board links and the relative-link open route
   *  (`board-links.ts`). */
  boardLinkRoutesCtx: BoardLinkRoutesContext;
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
