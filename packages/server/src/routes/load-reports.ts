import { isLoopbackAddress } from '../middleware/host-guard.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import { browserCannotOperateBody, isBrowserRequest } from '../middleware/write-gate.ts';
import { LOAD_REPORT_MAX_BYTES, type PageLoadLog, loadReportRefusal } from '../page-loads.ts';
import {
  BOARDLESS_PAGES,
  type LoadReportReading,
  type SlowLoadAlarm,
  pageTypeOf,
} from '../slow-load-alarm.ts';

/**
 * The load reports of pages on no board, and the read the daily health check
 * makes of every page's.
 *
 * A board's pages — the board, a doc, a mock, a diff, a folder — post to
 * their board's own `/workspaces/<ws>/load-reports`, which a share member of
 * that board may reach. Home (`/`) and the review page (`/review`) belong to
 * no board, so they post here. This route has the gate those two PAGES have:
 * `trusted-local`, with a share visitor refused. Anyone who can open Home or
 * `/review` can report how long it took, and nobody else; a share visitor
 * cannot reach either page, so there is no report of theirs to take.
 *
 * `GET /api/load-reports/slowest` is the slowest load per page type over the
 * last 24 hours. Loopback only, with `/api/repos`' three refusals (no
 * `cf-ray`, a loopback socket address, no browser): it names boards by id
 * across the whole server, which is a map of the machine's boards rather
 * than any one board's content, and the only reader it has is the lead's
 * health check on this box.
 */

export interface LoadReportRoutesContext {
  pageLoads: PageLoadLog;
  slowLoadAlarm: SlowLoadAlarm;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  /** The request's SOCKET address, never a header. */
  requestAddress: (req: Request) => string | undefined;
  now?: () => number;
}

export interface LoadReportRouteRequest {
  req: Request;
  pathname: string;
  /** The share target this request resolved to, or null for a member. */
  visitor: ShareTarget | null;
}

export async function handleLoadReportRoutes(
  ctx: LoadReportRoutesContext,
  rq: LoadReportRouteRequest,
): Promise<Response | null> {
  const { j, safeJson, requestAddress } = ctx;
  const { req, pathname, visitor } = rq;
  const now = ctx.now ?? Date.now;

  if (pathname === '/api/load-reports/slowest') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (req.headers.has('cf-ray')) {
      return j(403, {
        error: 'load timings cannot be read through the edge — run this on the box',
      });
    }
    if (!isLoopbackAddress(requestAddress(req))) {
      return j(403, { error: 'load timings are read from this machine only (loopback)' });
    }
    if (isBrowserRequest(req.headers)) return j(403, browserCannotOperateBody());
    if (req.method !== 'GET') return j(405, { error: 'method not allowed' });
    return j(200, ctx.pageLoads.slowestByPage(now()));
  }

  if (pathname === '/api/load-reports') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
    const body = await safeJson(req);
    if (body === null) return j(400, { error: 'report required' });
    const refusal = loadReportRefusal(body);
    if (refusal) return j(400, { error: refusal });
    const page = pageTypeOf((body as LoadReportReading).page);
    // A page on a board posts to that board, where its share members can
    // reach it; one arriving here would be a load filed under no board.
    if (!page || !BOARDLESS_PAGES.includes(page)) {
      return j(400, {
        error: `page must be one of ${BOARDLESS_PAGES.join(', ')}; a board's pages post to /workspaces/<ws>/load-reports`,
      });
    }
    // Measured on what would be kept, as the board's route measures its row.
    if (JSON.stringify(body).length > LOAD_REPORT_MAX_BYTES) {
      return j(400, { error: `report is over ${LOAD_REPORT_MAX_BYTES} bytes` });
    }
    const ts = now();
    // Kept first, judged second, as on the board's route: a raise that
    // throws cannot cost the reading that caused it.
    ctx.pageLoads.record(null, body as LoadReportReading, ts);
    ctx.slowLoadAlarm.consider(null, body as LoadReportReading, ts);
    return j(200, { ok: true });
  }

  return null;
}
