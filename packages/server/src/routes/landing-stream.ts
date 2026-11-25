/**
 * `GET /landing/events:stream` — the workspaces list's one live stream.
 *
 * It carries a single frame, `landing.changed`, whenever a board event that
 * can change `/` has been broadcast (`landing-changes.ts` decides which). The
 * frame names no board and carries no content: the page refetches `/` and
 * reads the answer through the same gate that served it the first time.
 *
 * Gated like `/` itself: trusted-local, the default for an address
 * `shareScopeAllows` does not name. A share visitor is refused here as well,
 * since a visitor is never shown `/`.
 */
import { LANDING_CHANNEL } from '../landing-changes.ts';
import { type SseBus, openSseStream } from '../sse.ts';
import { type RouteRow, rowHandlers } from './row-dispatch.ts';

export const LANDING_STREAM_PATH = '/landing/events:stream';

export interface LandingStreamRoutesContext {
  sse: SseBus;
  j: (status: number, body: unknown) => Response;
}

/** What only this request knows; `row` is the route-table row the router matched. */
interface LandingStreamRouteRequest {
  req: Request;
  row: RouteRow;
  visitor: unknown;
}

export function handleLandingStreamRoute(
  ctx: LandingStreamRoutesContext,
  r: LandingStreamRouteRequest,
): Response | null {
  return ROWS(ctx, r);
}

const ROWS = rowHandlers('landing-stream.ts', { [LANDING_STREAM_PATH]: answerStream });

function answerStream(ctx: LandingStreamRoutesContext, r: LandingStreamRouteRequest): Response {
  if (r.req.method !== 'GET') return ctx.j(405, { error: 'method-not-allowed' });
  if (r.visitor) return ctx.j(404, { error: 'not_found' });
  return openSseStream(ctx.sse, LANDING_CHANNEL);
}
