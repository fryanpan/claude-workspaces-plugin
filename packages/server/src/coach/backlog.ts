/**
 * What the coach session has not read yet, kept on disk until it does.
 *
 * The feed used to drop everything while the session was away: an event
 * with no stream to take it was not held, a window that closed during the
 * gap was thrown away, and a server restart threw away the window still
 * open. The session is respawned, compacted and reconnected many times a
 * day, so the digests missed exactly the stretches he worked away from it.
 * Now a window holds whatever he does, a closed one waits here, and the
 * session reads every waiting window as one digest when it is back.
 *
 * `<dataDir>/coach/backlog.json`, owner-only, written whole like the coach's
 * state file. Bounded twice: at most `MAX_HELD_DIGESTS` windows (a full day
 * of back-to-back ones), and none older than `MAX_HELD_AGE_MS`. A window
 * dropped for either is counted, so the session is told how many it missed.
 *
 * The open window is written at most every `WINDOW_WRITE_MS` and on stop,
 * so a crash loses at most that much; a closed window is written at once.
 */
import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../inbox/json-file.ts';
import type { DigestEvent, DigestItem } from './digest.ts';
import type { SessionTurn } from './session-minutes.ts';
import { COACH_DIRNAME } from './store.ts';

/** One thing a window holds: an event on a board, or a session's mark. */
export type HeldMark = { event: DigestEvent } | { turn: SessionTurn };

/** A window that closed with no session to read it. */
export interface HeldDigest {
  from: number;
  to: number;
  items: DigestItem[];
  turns: SessionTurn[];
}

interface BacklogFile {
  window?: { openedAt: number; items: HeldMark[] };
  digests: HeldDigest[];
  /** Windows dropped for the bounds since the session last read. */
  dropped: number;
}

export const MAX_HELD_DIGESTS = 96;
export const MAX_HELD_AGE_MS = 48 * 60 * 60_000;
const WINDOW_WRITE_MS = 30_000;

const empty = (): BacklogFile => ({ digests: [], dropped: 0 });

export class CoachBacklog {
  private readonly path: string;
  private state: BacklogFile;
  private windowWrittenAt = Number.NEGATIVE_INFINITY;

  constructor(dataDir: string, now: number = Date.now()) {
    this.path = join(dataDir, COACH_DIRNAME, 'backlog.json');
    const { value, error } = readJsonFile<BacklogFile>(this.path, empty(), now);
    if (error) console.warn(`[coach] backlog unreadable: ${error}; starting empty`);
    this.state = {
      digests: Array.isArray(value.digests) ? value.digests : [],
      dropped: typeof value.dropped === 'number' ? value.dropped : 0,
      ...(value.window && Array.isArray(value.window.items) ? { window: value.window } : {}),
    };
  }

  /** The window a restart interrupted, if any. */
  get window(): { openedAt: number; items: HeldMark[] } | undefined {
    return this.state.window;
  }

  /** The open window now, or null once it closed. Written at most every
   *  `WINDOW_WRITE_MS` unless `force`. */
  noteWindow(
    window: { openedAt: number; items: HeldMark[] } | null,
    now: number,
    force = false,
  ): void {
    if (window) this.state.window = window;
    else this.state.window = undefined;
    if (!force && window && now - this.windowWrittenAt < WINDOW_WRITE_MS) return;
    this.windowWrittenAt = now;
    this.write();
  }

  /** A window closed and nobody read it. */
  add(digest: HeldDigest, now: number): void {
    this.state.digests.push(digest);
    this.trim(now);
    this.write();
  }

  /** Every waiting window, oldest first, and how many were dropped. */
  waiting(now: number): { digests: HeldDigest[]; dropped: number } {
    if (this.trim(now)) this.write();
    return { digests: [...this.state.digests], dropped: this.state.dropped };
  }

  /** The session read these windows, as `waiting` handed them over, and
   *  heard the drop count. */
  delivered(read: readonly HeldDigest[]): void {
    const gone = new Set(read);
    this.state.digests = this.state.digests.filter((d) => !gone.has(d));
    this.state.dropped = 0;
    this.write();
  }

  flush(): void {
    this.write();
  }

  /** Drops what is past the bounds; true when anything went. */
  private trim(now: number): boolean {
    const before = this.state.digests.length;
    const fresh = this.state.digests.filter((d) => now - d.to <= MAX_HELD_AGE_MS);
    this.state.digests = fresh.slice(Math.max(0, fresh.length - MAX_HELD_DIGESTS));
    const gone = before - this.state.digests.length;
    this.state.dropped += gone;
    return gone > 0;
  }

  private write(): void {
    try {
      writeJsonFile(this.path, this.state);
    } catch (err) {
      console.warn(`[coach] backlog not written: ${String(err)}`);
    }
  }
}
