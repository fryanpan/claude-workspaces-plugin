/**
 * What every registered feature may read — the shared vocabulary of the
 * family list in `features.ts`, kept beside it the way
 * `task-routes-context.ts` sits beside the task routes.
 *
 * Long-lived values only; the request arrives per call as a
 * `FeatureRequest` (`feature-module.ts`). A new family that needs something
 * not named here adds it here, and `createServer` supplies it once — the one
 * edit to `server.ts` a family can need, and only when this server has never
 * handed that value to any family before.
 */
import type { Identities } from '../identities.ts';
import type { LandingPart } from '../landing-changes.ts';
import type { ServerOptions } from '../server-options.ts';
import type { TaskStore } from '../tasks.ts';

export interface FeatureDeps {
  dataDir: string;
  opts: ServerOptions;
  taskStore: TaskStore;
  /** The fleet address book — people and agents. */
  identities: Identities;
  /** Tell open `/` and `/review` pages that a part of `/` changed. */
  notifyLanding: (part: LandingPart) => void;
  /** The peer address a request arrived from, when Bun knows it. */
  requestAddress: (req: Request) => string | undefined;
  /** The board whose own socket a request arrived on, or null for TCP. */
  boardOfSocket: (req: Request) => string | null;
  /** The key an agent-stream token is checked against. */
  agentTokenKey: () => string;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
}
