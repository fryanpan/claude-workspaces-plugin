/**
 * Every page's load reports: what one may be, and the slowest load per page
 * type over the last day.
 *
 * Two routes take a report — a board's own (`POST /workspaces/<ws>/load-reports`,
 * for the board and every page filed on it) and the one for pages on no
 * board (`POST /api/load-reports`, Home and the review page). Both refuse
 * the same bodies for the same reasons, so the refusal lives here rather
 * than in either route.
 *
 * The board's per-board log answers "how did THIS board load". It cannot
 * answer the daily health check's question — "what was the slowest load of
 * each page type, anywhere, today" — without reading every board's file, and
 * Home and the review page have no board to file under. So every judged
 * report also lands, as one short row, in one server-wide log, and
 * `slowestByPage` reads it.
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type LoadReportReading,
  PAGE_LOAD_BUDGET_MS,
  PAGE_TYPES,
  type PageType,
  contentReading,
  pageTypeOf,
} from './slow-load-alarm.ts';

/**
 * What a load report may be.
 *
 * A board's route is on the share-member route table, so every call is a
 * write to a file on the OWNER's machine by anybody holding a link to the
 * board. It used to append whatever JSON parsed — no shape, no ceiling — so
 * a telemetry endpoint doubled as somewhere to park arbitrary data on
 * somebody else's disk.
 *
 * The shape below is what the clients actually send: a flat handful of
 * numbers and one page type (`page-load-report.ts`). Flat is the
 * load-bearing part — a nested value is where an unbounded payload hides —
 * and the limits sit an order of magnitude above the real thing so a field
 * added to a client lands without anyone having to come back here.
 */
export const LOAD_REPORT_MAX_BYTES = 2_000;
const LOAD_REPORT_MAX_FIELDS = 24;
const LOAD_REPORT_MAX_STRING = 400;

/** Why this body is not a load report, or null when it is one. */
export function loadReportRefusal(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'report must be a JSON object';
  }
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length > LOAD_REPORT_MAX_FIELDS) {
    return `report may hold at most ${LOAD_REPORT_MAX_FIELDS} fields`;
  }
  for (const [key, value] of entries) {
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return `${key} must be a finite number`;
      continue;
    }
    if (typeof value === 'string') {
      if (value.length > LOAD_REPORT_MAX_STRING) {
        return `${key} is over ${LOAD_REPORT_MAX_STRING} characters`;
      }
      continue;
    }
    // Objects and arrays, which is where an unbounded payload would live.
    return `${key} must be a number, string, boolean or null — a report is flat`;
  }
  if (pageTypeOf((body as LoadReportReading).page) === null) {
    return `page must be one of ${PAGE_TYPES.join(', ')}`;
  }
  return null;
}

/** One row of the server-wide log: when, which page, which board, how long. */
export interface PageLoadRow {
  ts: number;
  page: PageType;
  /** The board, or absent for a page on no board. */
  ws?: string;
  /** ms to the main content, or null when it never arrived. */
  ms: number | null;
}

/** The slowest load of one page type in the window. */
export interface PageLoadSummary {
  loads: number;
  /** Loads whose content never arrived before the client gave up. */
  neverArrived: number;
  /** Loads over the budget, counting the ones that never arrived. */
  overBudget: number;
  /** The slowest load that did arrive, or null when none did. */
  slowestMs: number | null;
  slowestAt: number | null;
  /** The board the slowest load was on, or null for a page on no board. */
  slowestWorkspaceId: string | null;
}

export interface SlowestByPage {
  windowMs: number;
  budgetMs: number;
  /** Every page type, including the ones that reported nothing: a page type
   *  with no loads in a day is itself a finding — its reporting is broken. */
  pages: Record<PageType, PageLoadSummary>;
}

/** How far back `slowestByPage` reads. The health check runs daily. */
export const PAGE_LOAD_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How large the log may get before it is rewritten to the last day's rows.
 *
 * Rows are RETIRED rather than refused, for the per-board log's reason: a
 * full log that stops accepting them would turn a disk bound into a
 * monitoring outage. A row is about 70 bytes, so the ceiling is several
 * thousand loads; past `PAGE_LOAD_KEEP_ROWS` in one day the oldest of that
 * day go first, and the read covers less than 24 h.
 */
const PAGE_LOAD_LOG_MAX_BYTES = 512_000;
const PAGE_LOAD_KEEP_ROWS = 5_000;

export class PageLoadLog {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'page-loads.jsonl');
  }

  /**
   * Keep one judged report. A report the alarm cannot judge (no boot stamp)
   * is not kept either, so the log and the alarm count the same loads.
   */
  record(workspaceId: string | null, report: LoadReportReading, ts: number): void {
    const reading = contentReading(report);
    if (!reading) return;
    const row: PageLoadRow = {
      ts,
      page: reading.page,
      ...(workspaceId ? { ws: workspaceId } : {}),
      ms: reading.msToContent,
    };
    try {
      this.trim(ts);
      appendFileSync(this.path, `${JSON.stringify(row)}\n`);
    } catch (err) {
      // The recorder never takes the report down with it: the per-board log
      // and the alarm still run.
      console.error('[page-loads] failed to record a load:', err);
    }
  }

  /** The slowest load per page type over the window ending at `now`. */
  slowestByPage(now: number, windowMs: number = PAGE_LOAD_WINDOW_MS): SlowestByPage {
    const pages = Object.fromEntries(
      PAGE_TYPES.map((p) => [
        p,
        {
          loads: 0,
          neverArrived: 0,
          overBudget: 0,
          slowestMs: null,
          slowestAt: null,
          slowestWorkspaceId: null,
        },
      ]),
    ) as Record<PageType, PageLoadSummary>;
    for (const row of this.rows()) {
      if (row.ts < now - windowMs || row.ts > now) continue;
      const s = pages[row.page];
      s.loads += 1;
      if (row.ms === null) {
        s.neverArrived += 1;
        s.overBudget += 1;
        continue;
      }
      if (row.ms > PAGE_LOAD_BUDGET_MS) s.overBudget += 1;
      if (s.slowestMs === null || row.ms > s.slowestMs) {
        s.slowestMs = row.ms;
        s.slowestAt = row.ts;
        s.slowestWorkspaceId = row.ws ?? null;
      }
    }
    return { windowMs, budgetMs: PAGE_LOAD_BUDGET_MS, pages };
  }

  private rows(): PageLoadRow[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const row = JSON.parse(line) as PageLoadRow;
          // A torn tail line, or a row from a page type this server no longer
          // knows, must not take the whole read down.
          const page = pageTypeOf(row.page);
          if (typeof row.ts !== 'number' || page === null) return [];
          return [{ ...row, page }];
        } catch {
          return [];
        }
      });
  }

  private trim(now: number): void {
    if (!existsSync(this.path) || statSync(this.path).size <= PAGE_LOAD_LOG_MAX_BYTES) return;
    const kept = this.rows()
      .filter((r) => r.ts >= now - PAGE_LOAD_WINDOW_MS)
      .slice(-PAGE_LOAD_KEEP_ROWS);
    writeFileSync(this.path, kept.map((r) => `${JSON.stringify(r)}\n`).join(''));
  }
}
