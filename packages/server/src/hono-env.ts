/**
 * What a router below the gates is handed: the shared names of the Hono move
 * (milestone M12).
 *
 * `routes/hono-gates.ts` produces a `PassedGates` in the router app's
 * `c.var`; the family apps below the gates (`routes/hono-front.ts`) read it as
 * their env. These types live
 * outside `routes/` because `server-options.ts` names `HonoFamily` for the
 * `honoFamilies` option, and nothing outside `routes/` but `server.ts` may
 * import from there (`bun run check:imports`).
 */
import type { Hono } from 'hono';
import type { WorkspaceScope } from './middleware/workspace-scope.ts';
import type { AttributableRequest, Attribution } from './request-attribution.ts';
import type { BoardWorkspace } from './tasks.ts';

/** What the gates proved about a request they let through. */
export interface PassedGates {
  gate: AttributableRequest;
  attribution: Extract<Attribution, { attributed: true }>;
}

/** What every Hono handler reads as `c.env`. */
export interface HonoGateEnv extends PassedGates {
  /** A person proof naming the owner (`routes/hono-app.ts`). */
  ownerProven: () => boolean;
}

/**
 * The router app (`routes/hono-app.ts`): the gates set `gate` and
 * `attribution` as they pass a request, and the middleware after them adds
 * `ownerProven`. Read only below the gates — a gate above admission (the open
 * families) runs before any of these is set.
 */
export interface HonoRouterEnv {
  Variables: PassedGates & {
    /** A person proof naming the owner. */
    ownerProven: () => boolean;
  };
}

/** The type parameter of the app every family registers on. */
export interface HonoAppEnv {
  Bindings: HonoGateEnv;
}

/** One route family: registers its routes on the shared app. */
export type HonoFamily = (app: Hono<HonoAppEnv>) => void;

/**
 * What the board app (`routes/hono-board-families.ts`) reads as `c.env`: the
 * gates' proof, plus whether this request may mint an app's voice token.
 */
export interface HonoBoardEnv extends HonoGateEnv {
  mayMintAppVoice: () => boolean;
}

/**
 * What the board app's first middleware resolves and every family after it
 * reads as `c.var`: the workspace scope (`middleware/workspace-scope.ts`).
 */
export interface HonoBoardVars {
  /** Undefined for an address outside `/workspaces/<id>/…`. */
  scope: WorkspaceScope<BoardWorkspace> | undefined;
}

/** The type parameter of the board app. */
export interface HonoBoardAppEnv {
  Bindings: HonoBoardEnv;
  Variables: HonoBoardVars;
}

/** One board family: registers its routes on the board app. */
export type HonoBoardFamily = (app: Hono<HonoBoardAppEnv>) => void;

/**
 * The type parameter of the open app (`routes/hono-open-families.ts`), tried
 * inside the gates above admission. Nothing has been proved yet, so its env
 * is empty: each family there checks its own caller.
 */
export interface HonoOpenAppEnv {
  Bindings: Record<never, never>;
}

/** One open family: registers its routes on the open app. */
export type HonoOpenFamily = (app: Hono<HonoOpenAppEnv>) => void;
