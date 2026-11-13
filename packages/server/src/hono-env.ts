/**
 * What a router below the gates is handed: the shared names of the Hono move
 * (milestone M12).
 *
 * `routes/request-chain-gates.ts` produces a `PassedGates`; the ordered chain
 * and the Hono app (`routes/hono-front.ts`) both read it. These types live
 * outside `routes/` because `server-options.ts` names `HonoFamily` for the
 * `honoFamilies` option, and nothing outside `routes/` but `server.ts` may
 * import from there (`bun run check:imports`).
 */
import type { Hono } from 'hono';
import type { AttributableRequest, Attribution } from './request-attribution.ts';

/** What the gates proved about a request they let through. */
export interface PassedGates {
  gate: AttributableRequest;
  attribution: Extract<Attribution, { attributed: true }>;
}

/** What every Hono handler reads as `c.env`. */
export interface HonoGateEnv extends PassedGates {
  /** A person proof naming the owner (`routes/request-chain.ts`). */
  ownerProven: () => boolean;
}

/** The type parameter of the app every family registers on. */
export interface HonoAppEnv {
  Bindings: HonoGateEnv;
}

/** One route family: registers its routes on the shared app. */
export type HonoFamily = (app: Hono<HonoAppEnv>) => void;
