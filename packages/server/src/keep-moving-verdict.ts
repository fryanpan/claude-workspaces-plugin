/**
 * The keep-moving verdict: is this board working, yes or no, once per cadence.
 *
 * The stall check's promise is in `docs/architecture/stall-check/README.md`:
 * every open row is moving or names its blocker where the person it waits
 * on can answer it, and nothing reaches that person they cannot act on. This
 * module is the MEASUREMENT of that promise — a PASS or FAIL per board with
 * the lines behind it — and nothing else. It files nothing, wakes nobody and
 * appears on no board (the owner's call, 2026-09-08: "an internal process
 * … do run it reliably once per workspace").
 *
 * It replaced a box cron (`com.fryanpan.keep-moving-report`) that posted the
 * same verdict as a ticket comment every four hours. That cron broke on the
 * routes cutover of 2026-08-29 and posted 404s for nine days before anyone
 * noticed, because the report was the thing that would have noticed. So
 * this one runs INSIDE the server, on the stall tick, off the same snapshot
 * the lead's wake is built from: it cannot read a different board than the
 * wake reads, and it cannot silently stop while the server is up.
 *
 * What a verdict reads, all from `StallSnapshot`:
 *
 *   stalled     rows that should be moving and are not
 *   unfiled     rows waiting on a person with nothing on that person's queue
 *   unreadable  rows the gate could not judge
 *   held        review items the quality gate has held longer than the
 *               board's own quiet window — an ask on nobody's queue
 *   escalated   review items the BOARD filed to the reader inside the last
 *               day (`stall-escalation.ts`) — the last resort, counted so
 *               that it is visible when it is not a last resort
 *
 * Any of them non-zero is a FAIL. A FAIL is not an alarm — the wake already
 * told the lead — it is the record that the promise was not kept at that
 * moment, so a week of verdicts answers "is this working" with a number
 * rather than a feeling.
 *
 * Cadence is per board and persisted, so a restart mid-window resumes the
 * window rather than re-recording every board on boot; history is capped per
 * board at a week of four-hourly verdicts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StallSnapshot } from './stall-nudge.ts';

/** Default: four hours, the cadence the old report ran on. */
export const KEEP_MOVING_CADENCE_DEFAULT_MS = 4 * 60 * 60_000;
/** A week of four-hourly verdicts. */
export const KEEP_MOVING_HISTORY_KEEP = 42;
/** The window an escalation item counts against — one day. */
export const KEEP_MOVING_ESCALATED_WINDOW_MS = 24 * 60 * 60_000;
/** Where verdicts persist under the data dir. */
export const KEEP_MOVING_VERDICTS_FILENAME = 'keep-moving-verdicts.json';

export interface KeepMovingVerdict {
  workspaceId: string;
  at: number;
  verdict: 'PASS' | 'FAIL';
  /** How many open rows the gate examined — the denominator. */
  considered: number;
  /** Row ids, quietest first. */
  stalled: string[];
  unfiled: string[];
  unreadable: string[];
  /** Held review items older than the window — the item ids. */
  held: string[];
  /** How many items the board filed to the reader inside the last day. */
  escalated: number;
}

export interface KeepMovingRecorderOptions {
  /** Sidecar path. Absent keeps verdicts in memory only (tests). */
  path?: string;
  cadenceMs?: number;
  /** How long a held item may stand before it counts. The board's quiet
   *  window, by default the same 20 minutes a row gets. */
  heldOverMs?: number;
  /** How many review items the board itself filed to the reader on this
   *  workspace since `since`. */
  escalatedSince: (workspaceId: string, since: number) => number;
  /** Where the log line goes. */
  say?: (line: string) => void;
}

const HELD_OVER_DEFAULT_MS = 20 * 60_000;

/** The verdict for one board at one instant. Pure; exported for the tests. */
export function keepMovingVerdictFor(
  snapshot: StallSnapshot,
  now: number,
  opts: { heldOverMs: number; escalated: number },
): KeepMovingVerdict {
  const held = (snapshot.held ?? [])
    .filter((h) => h.heldMs > opts.heldOverMs)
    .map((h) => h.reviewItemId);
  const stalled = snapshot.stalled.map((r) => r.id);
  const unfiled = snapshot.unfiled.map((r) => r.id);
  const unreadable = snapshot.undetermined.map((r) => r.id);
  const failing =
    stalled.length > 0 ||
    unfiled.length > 0 ||
    unreadable.length > 0 ||
    held.length > 0 ||
    opts.escalated > 0;
  return {
    workspaceId: snapshot.workspaceId,
    at: now,
    verdict: failing ? 'FAIL' : 'PASS',
    considered: snapshot.considered,
    stalled,
    unfiled,
    unreadable,
    held,
    escalated: opts.escalated,
  };
}

type Sidecar = Record<string, KeepMovingVerdict[]>;

export class KeepMovingRecorder {
  private readonly path: string | undefined;
  private readonly cadenceMs: number;
  private readonly heldOverMs: number;
  private readonly escalatedSince: KeepMovingRecorderOptions['escalatedSince'];
  private readonly say: (line: string) => void;
  private sidecar: Sidecar = {};
  private lastPersisted = '';

  constructor(opts: KeepMovingRecorderOptions) {
    this.path = opts.path;
    this.cadenceMs = opts.cadenceMs ?? KEEP_MOVING_CADENCE_DEFAULT_MS;
    this.heldOverMs = opts.heldOverMs ?? HELD_OVER_DEFAULT_MS;
    this.escalatedSince = opts.escalatedSince;
    this.say = opts.say ?? ((line) => console.log(line));
    this.load();
  }

  /**
   * One tick's worth of boards. Records a verdict for every board whose last
   * one is older than the cadence, and returns what it recorded. A retired
   * board is skipped: nobody is working it, so there is no promise to keep.
   */
  observe(snapshots: readonly StallSnapshot[], now: number): KeepMovingVerdict[] {
    const recorded: KeepMovingVerdict[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.retired) continue;
      const last = this.latest(snapshot.workspaceId);
      if (last && now - last.at < this.cadenceMs) continue;
      const verdict = keepMovingVerdictFor(snapshot, now, {
        heldOverMs: this.heldOverMs,
        escalated: this.escalatedSince(snapshot.workspaceId, now - KEEP_MOVING_ESCALATED_WINDOW_MS),
      });
      const history = this.sidecar[snapshot.workspaceId] ?? [];
      history.push(verdict);
      this.sidecar[snapshot.workspaceId] = history.slice(-KEEP_MOVING_HISTORY_KEEP);
      recorded.push(verdict);
      this.say(
        `[keep-moving] ws=${verdict.workspaceId} verdict=${verdict.verdict} ` +
          `considered=${verdict.considered} stalled=${verdict.stalled.length} ` +
          `unfiled=${verdict.unfiled.length} unreadable=${verdict.unreadable.length} ` +
          `held=${verdict.held.length} escalated=${verdict.escalated}`,
      );
    }
    if (recorded.length > 0) this.save();
    return recorded;
  }

  latest(workspaceId: string): KeepMovingVerdict | undefined {
    const history = this.sidecar[workspaceId];
    return history?.[history.length - 1];
  }

  /** Oldest first. */
  history(workspaceId: string): readonly KeepMovingVerdict[] {
    return this.sidecar[workspaceId] ?? [];
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.sidecar = parsed as Sidecar;
        this.lastPersisted = this.serialize();
      }
    } catch {
      // A corrupt file costs one early verdict per board, never a crash.
      this.sidecar = {};
    }
  }

  private serialize(): string {
    const out: Sidecar = {};
    for (const key of Object.keys(this.sidecar).sort()) {
      const history = this.sidecar[key];
      if (history && history.length > 0) out[key] = history;
    }
    return `${JSON.stringify(out, null, 2)}\n`;
  }

  /** Never throws: this runs inside a timer tick. */
  private save(): void {
    if (!this.path) return;
    const next = this.serialize();
    if (next === this.lastPersisted) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, next);
      renameSync(tmp, this.path);
      this.lastPersisted = next;
    } catch (err) {
      console.error('[keep-moving] could not persist verdicts:', err);
    }
  }
}
