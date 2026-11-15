/**
 * A route CONTRACT: a Hono app that declares routes for the MCP's typed
 * client (`hc`) and never serves a request.
 *
 * The mounts family moved its handler bodies into a serving Hono app
 * (`mounts-api.ts`). The other families are hand-dispatch handlers of 700 to
 * 1,300 lines, and moving them would be a rewrite. So a contract declares each
 * route the MCP calls, with its method, path, body and query, and the
 * existing handler keeps serving it.
 *
 * Two couplings keep the contract honest:
 * - **Fields.** The handler branch reads its body as `Sent<B>` with
 *   `sent<B>(await safeJson(req))`, where `B` is the type the contract
 *   declares. A field renamed in `B` fails typecheck in the handler that reads
 *   it and in the MCP tool that sends it.
 * - **Paths.** `test/route-contracts.test.ts` holds every declared route to a
 *   row of `test/fixtures/route-answers.json` that a family handler answers.
 *   A declared path that no family serves fails there.
 */
import type { MiddlewareHandler } from 'hono';

/** What a handler sees of a field a caller sent: present or not, unchecked. */
export type Sent<T> = { [K in keyof T]?: unknown };

/** A body as `safeJson` read it, typed as the contract declares it. */
export function sent<T>(raw: Record<string, unknown> | null): Sent<T> | null {
  return raw as Sent<T> | null;
}

/** Declares the JSON body `B`. Never runs: a contract serves nothing. */
export function json<B>(): MiddlewareHandler<
  Record<string, never>,
  string,
  { in: { json: B }; out: { json: Sent<B> } }
> {
  return neverRuns;
}

/** Declares the query string `Q`. Never runs. */
export function query<Q extends Record<string, string | undefined>>(): MiddlewareHandler<
  Record<string, never>,
  string,
  { in: { query: Q }; out: { query: Partial<Q> } }
> {
  return neverRuns;
}

const REFUSAL = 'a route contract was asked to serve a request; it only declares routes';

/** The handler of every declared route. Reaching it is a wiring bug. */
export function contractOnly(): Response {
  throw new Error(REFUSAL);
}

async function neverRuns(): Promise<void> {
  throw new Error(REFUSAL);
}
