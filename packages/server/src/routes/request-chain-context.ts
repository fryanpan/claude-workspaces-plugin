/**
 * The request chain's shared vocabulary: every long-lived value the chain
 * reads (`RequestChainContext`).
 *
 * `createServer` builds the context once, after every route family's own
 * context exists. Nothing in it is per request; what the gates proved about a
 * request travels to the Hono apps as their env (`hono-env.ts`).
 */
import type { addressesLocalOnlySet } from '../attachment-privacy.ts';
import type { DocStore } from '../doc-store.ts';
import type { HonoBoardEnv, HonoOpenAppEnv } from '../hono-env.ts';
import type { IdentityRecord } from '../identities.ts';
import type { OriginPolicy } from '../middleware/browser-origin.ts';
import type { RequestAdmission } from '../request-admission.ts';
import type { AttributableRequest, RequestAttribution } from '../request-attribution.ts';
import type { HonoFront } from './hono-front.ts';
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
  /** The open Hono app (`hono-front.ts`) with the families it answers
   *  (`hono-open-families.ts`): the home feed, the board import and the
   *  GitHub hub, tried inside the gates above admission. */
  honoOpenFront: HonoFront<HonoOpenAppEnv['Bindings']>;
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
  /** The front Hono app (`hono-front.ts`) with the families it answers
   *  (`hono-families.ts`), tried below the gates and above the stream run. */
  honoFront: HonoFront;
  serveUpgradeAndStreamRoutes: UpgradeStream['serveUpgradeAndStreamRoutes'];
  workspacesOfMember: (collection: string, memberId: string) => readonly string[];

  // ── The board app ──
  /** The board app (`hono-front.ts`): the workspace scope, the board
   *  families (`hono-board-families.ts`) and the tail
   *  (`hono-tail-families.ts`), tried below the stream block. */
  honoBoardFront: HonoFront<HonoBoardEnv>;
}
