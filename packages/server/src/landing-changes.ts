/**
 * The workspaces list's change feed: one frame telling an open `/` that what
 * it drew is stale.
 *
 * `/` is server-rendered from every board at once — the review bar and its
 * goal sections, each board's row, its last activity — so an open page has
 * no single board stream to follow, and a browser cannot hold one stream per
 * board: HTTP/1.1 allows six connections per host, and an owner has more
 * boards than that.
 * So the server listens to every broadcast, keeps the ones that can change
 * what `/` shows, and sends `landing.changed` on one channel. The page
 * refetches `/` and swaps the parts it drew (`landing-live.ts`).
 *
 * What counts is decided by event name, never by payload, so the filter
 * reads no board content. A board channel (`ws~<id>`) carries task, goal,
 * review-item and decision events; a doc channel counts only for a thread
 * event, since an ask is a thread. Agent presence, heartbeats, receipts and
 * meeting traffic change nothing on `/` and would only spend a re-render.
 *
 * Bursts coalesce: the first counted event arms a timer and the frame goes
 * out when it fires, so an agent filing ten tasks in a loop costs one
 * refetch per open page, not ten.
 *
 * The frame names the PARTS of `/` the burst touched, so the page re-reads
 * only those. `boards` is everything a board broadcast reaches (the review
 * bar and the board list); Incoming Messages and the meeting banner have
 * stores of their own that broadcast nothing, and their writers
 * call `notify` with their part. `/review` listens on the same channel and
 * re-reads its queue on `boards`.
 */

/** The bus channel open `/` pages listen on. Not a doc id or a board key,
 *  so nothing else broadcasts on it. */
export const LANDING_CHANNEL = 'landing~';
export const LANDING_CHANGED_EVENT = 'landing.changed';

/** How long a burst of board events gathers before one frame goes out. */
export const LANDING_COALESCE_MS = 250;

/** The parts of `/` a frame can name. */
export type LandingPart = 'boards' | 'inbox' | 'meeting';

const BOARD_EVENT_PREFIXES = ['task.', 'workspace.', 'review_item.', 'decision.', 'thread.'];

/** Whether a broadcast on `channel` named `event` can change what `/` shows. */
export function stalesLanding(channel: string, event: string): boolean {
  if (channel === LANDING_CHANNEL) return false;
  if (channel.startsWith('ws~')) return BOARD_EVENT_PREFIXES.some((p) => event.startsWith(p));
  return event.startsWith('thread.');
}

export interface LandingChanges {
  /** Feed one broadcast through the filter. */
  observe: (channel: string, event: string) => void;
  /** Mark a part of `/` stale for a change that no broadcast carries: a
   *  lead's rank or a new board (`boards`), or the inbox or calendar
   *  stores. */
  notify: (part?: LandingPart) => void;
  dispose: () => void;
}

export function createLandingChanges(opts: {
  /** Send the frame to every open page, naming the parts that changed. */
  emit: (parts: LandingPart[]) => void;
  coalesceMs?: number;
}): LandingChanges {
  const coalesceMs = opts.coalesceMs ?? LANDING_COALESCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<LandingPart>();
  const notify = (part: LandingPart = 'boards'): void => {
    pending.add(part);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const parts = [...pending].sort();
      pending.clear();
      opts.emit(parts);
    }, coalesceMs);
    (timer as { unref?: () => void }).unref?.();
  };
  return {
    observe: (channel, event) => {
      if (stalesLanding(channel, event)) notify('boards');
    },
    notify,
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
