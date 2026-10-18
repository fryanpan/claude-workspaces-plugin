/**
 * How much of the owner's day reached the coach: per hour, what the server
 * received from him, by source, next to what the digests carried.
 *
 * Bryan read a day's digests and found them "incredibly incomplete", and
 * nothing could say where the rest went. This counts three things per hour:
 *
 *  - **received**: each owner signal as it arrives, by source and kind. A
 *    page's `view`, `wrote` and `left` (`POST /coach/here`); a comment,
 *    reply or doc open from the activity record; a typed or injected prompt
 *    and a turn end from an attached session.
 *  - **dropped**: each one the coach let go, by why (`DropReason`).
 *  - **carried**: what a delivered digest held, by source and kind, with
 *    the minutes of page stays and session time. A mark is counted in the
 *    hour it happened, when the digest that holds it is delivered.
 *
 * The source is read at intake (`sourceOfDevice`, `sessionSource`): a
 * browser's user agent, as `event-origin.ts` classifies it for every
 * activity row, and for a session's prompt, whether the hook ran under
 * Remote Control (`CLAUDE_CODE_BRIDGE_SESSION_ID`). A turn end has the
 * source of its session's last prompt.
 *
 * Counts only: never text, titles, paths or ids. `<dataDir>/coach/coverage.json`,
 * owner-only, written at most every `WRITE_MS` and on stop. Hours older
 * than `KEEP_HOURS` are dropped as new ones arrive, so the file holds at
 * most eight days.
 */
import { join } from 'node:path';
import { instantForLocal, zonedParts } from '@claude-workspaces/core/schedule-timezone';
import type { DeviceKind } from '../event-origin.ts';
import { readJsonFile, writeJsonFile } from '../inbox/json-file.ts';
import { COACH_DIRNAME } from './store.ts';

export const COVERAGE_SOURCES = [
  'desktop',
  'ipad',
  'phone',
  'remote-control',
  'terminal',
  'other',
] as const;
export type CoverageSource = (typeof COVERAGE_SOURCES)[number];

/** What arrived. */
export type ReceivedKind =
  | 'view'
  | 'wrote'
  | 'left'
  | 'comment'
  | 'reply'
  | 'open'
  | 'typed-prompt'
  | 'injected-prompt'
  | 'turn-end';

/** Why the coach let a signal go. */
export type DropReason =
  /** On a board the coach is off for. */
  | 'off-board'
  /** The coach's own session. */
  | 'coach-session'
  /** The day's turn budget was spent. */
  | 'paused'
  /** A page said the same place, heading and passage again. */
  | 'repeat'
  /** A turn end or injected prompt with no typed prompt in the run. */
  | 'outside-run'
  /** A page signal the route refused: a bad body, or another origin. */
  | 'refused';

/** What a digest carried. The two `-ms` kinds are durations, the rest counts. */
export type CarriedKind =
  | 'view'
  | 'wrote'
  | 'left'
  | 'comment'
  | 'reply'
  | 'open'
  | 'prompt'
  | 'injected'
  | 'turn'
  | 'view-ms'
  | 'session-ms';

/** One carried count: the hour it happened in, and what. */
export type CarriedCount = [hour: number, source: CoverageSource, kind: CarriedKind, n: number];

const HOUR_MS = 60 * 60_000;
export const KEEP_HOURS = 8 * 24;
const WRITE_MS = 60_000;

/** A browser's device kind as a source; no device is `other`. */
export function sourceOfDevice(kind: DeviceKind | undefined): CoverageSource {
  return kind === 'desktop' || kind === 'ipad' || kind === 'phone' ? kind : 'other';
}

/** A session's prompt mark: Remote Control when the hook said so. */
export function sessionSource(remote: boolean | undefined): CoverageSource {
  return remote ? 'remote-control' : 'terminal';
}

export const hourOf = (at: number): number => Math.floor(at / HOUR_MS) * HOUR_MS;

type Table = 'received' | 'dropped' | 'carried';
type Counts = Record<string, Record<string, number>>;
interface Hour {
  received: Counts;
  dropped: Record<string, number>;
  carried: Counts;
}
interface CoverageFile {
  hours: Record<string, Hour>;
}

/** One hour of the report. */
export interface CoverageHour {
  /** Local `HH:MM` the hour starts at. */
  local: string;
  start: string;
  /** source → kind → count. */
  received: Counts;
  dropped: Record<string, number>;
  /** source → kind → count; `view-ms` and `session-ms` come out as minutes. */
  carried: Counts;
}

export interface CoverageReport {
  date: string;
  timeZone: string;
  hours: CoverageHour[];
}

const emptyHour = (): Hour => ({ received: {}, dropped: {}, carried: {} });

export class CoachCoverage {
  private readonly path: string;
  private state: CoverageFile;
  private writtenAt = Number.NEGATIVE_INFINITY;
  private dirty = false;

  constructor(dataDir: string, now: number = Date.now()) {
    this.path = join(dataDir, COACH_DIRNAME, 'coverage.json');
    const { value, error } = readJsonFile<CoverageFile>(this.path, { hours: {} }, now);
    if (error) console.warn(`[coach] coverage unreadable: ${error}; starting empty`);
    this.state = {
      hours: value && typeof value.hours === 'object' && value.hours !== null ? value.hours : {},
    };
  }

  received(at: number, source: CoverageSource, kind: ReceivedKind): void {
    this.add('received', at, source, kind, 1);
  }

  dropped(at: number, reason: DropReason): void {
    const h = this.hour(at);
    h.dropped[reason] = (h.dropped[reason] ?? 0) + 1;
    this.changed(at);
  }

  /** A digest was delivered holding these. */
  carried(counts: readonly CarriedCount[], now: number): void {
    for (const [hour, source, kind, n] of counts) this.add('carried', hour, source, kind, n, now);
    this.changed(now);
  }

  /** The local day `date` (`YYYY-MM-DD`) in `timeZone`, hour by hour. */
  report(date: string, timeZone: string): CoverageReport {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const start = instantForLocal(timeZone, y, m, d, 0, 0);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const end = instantForLocal(
      timeZone,
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      0,
      0,
    );
    const hours: CoverageHour[] = [];
    for (let t = hourOf(start); t < end; t += HOUR_MS) {
      const h = this.state.hours[String(t)] ?? emptyHour();
      const p = zonedParts(Math.max(t, start), timeZone);
      hours.push({
        local: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
        start: new Date(t).toISOString(),
        received: h.received,
        dropped: h.dropped,
        carried: asMinutes(h.carried),
      });
    }
    return { date, timeZone, hours };
  }

  /** Write anything held back. */
  flush(): void {
    if (this.dirty) this.write();
  }

  private add(
    table: Exclude<Table, 'dropped'>,
    at: number,
    source: CoverageSource,
    kind: string,
    n: number,
    now = at,
  ): void {
    const bySource = this.hour(at)[table];
    const kinds = bySource[source] ?? {};
    kinds[kind] = (kinds[kind] ?? 0) + n;
    bySource[source] = kinds;
    if (table === 'received') this.changed(now);
  }

  private hour(at: number): Hour {
    const key = String(hourOf(at));
    let h = this.state.hours[key];
    if (!h) {
      h = emptyHour();
      this.state.hours[key] = h;
      const keys = Object.keys(this.state.hours)
        .map(Number)
        .sort((a, b) => a - b);
      for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_HOURS))) {
        delete this.state.hours[String(old)];
      }
    }
    return h;
  }

  private changed(now: number): void {
    this.dirty = true;
    if (now - this.writtenAt < WRITE_MS) return;
    this.write();
    this.writtenAt = now;
  }

  private write(): void {
    this.dirty = false;
    try {
      writeJsonFile(this.path, this.state);
    } catch (err) {
      console.warn(`[coach] coverage not written: ${String(err)}`);
    }
  }
}

function asMinutes(carried: Counts): Counts {
  const out: Counts = {};
  for (const [source, kinds] of Object.entries(carried)) {
    const k: Record<string, number> = {};
    for (const [kind, n] of Object.entries(kinds)) {
      if (kind.endsWith('-ms')) k[`${kind.slice(0, -3)}-minutes`] = Math.round(n / 60_000);
      else k[kind] = n;
    }
    out[source] = k;
  }
  return out;
}
