/**
 * Following someone: when their spot moves, this view goes there — scrolled
 * to it on the same page, opened at it on another page of the workspace.
 *
 * A follow is armed by a long-press on a presence chip, on any page, and
 * outlives the navigation it causes: the key is kept in `sessionStorage`
 * per workspace, with the address it is sending this tab to. The page that
 * loads there finds its own address in the record and keeps following; a
 * page that loads anywhere else was reached by the reader, so the follow
 * ends.
 *
 * It also ends the moment the reader moves on their own — a scroll, a key,
 * a tap anywhere but the presence chips. Moving the view for them is only
 * welcome while they are watching.
 */
import { type PresenceSpot, samePage } from '@claude-workspaces/core/workspace-presence';
import { type RoomStates, spotHref, spotKey, spotOfParticipant } from './follow-model.ts';

/** The slice of a Yjs awareness this reads. */
export interface FollowRoom {
  clientID: number;
  getStates(): RoomStates;
  on(event: 'change', fn: () => void): void;
}

export interface FollowStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FollowerDeps {
  room: FollowRoom;
  workspaceId: string;
  /** Where this view is now. */
  here: () => PresenceSpot;
  /** This tab's address, path and query — compared with a follow's arrival. */
  address: () => string;
  /** Open another page of the workspace. */
  go: (href: string) => void;
  /** Move this page's view to a spot on it. */
  show: (spot: PresenceSpot) => void;
  storage: FollowStorage;
  /** Who is followed changed — the strip repaints its ring. */
  onChange?: (key: string | null) => void;
}

export interface Follower {
  key(): string | null;
  /** Follow `key`, or stop following with null. */
  follow(key: string | null): void;
  /** Go to where `key` is once, without following. */
  jump(key: string): void;
  /** Re-read the room; the page calls it when its own view changed page. */
  refresh(): void;
}

interface Stored {
  key: string;
  /** The address the follow is sending this tab to, until it lands. */
  arriving?: string;
}

export const followStorageKey = (workspaceId: string): string => `cw-follow:${workspaceId}`;

export function createFollower(deps: FollowerDeps): Follower {
  const slot = followStorageKey(deps.workspaceId);
  const read = (): Stored | null => {
    try {
      const v = JSON.parse(deps.storage.getItem(slot) ?? 'null') as Stored | null;
      return v && typeof v.key === 'string' ? v : null;
    } catch {
      return null;
    }
  };
  const write = (v: Stored | null): void => {
    if (v) deps.storage.setItem(slot, JSON.stringify(v));
    else deps.storage.removeItem(slot);
  };

  let current: string | null = null;
  let applied: string | null = null;
  const stored = read();
  if (stored) {
    // Landed where the follow sent us, or reloaded mid-follow: keep going.
    // Anywhere else, the reader navigated themselves.
    if (!stored.arriving || stored.arriving === deps.address()) {
      current = stored.key;
      write({ key: stored.key });
    } else {
      write(null);
    }
  }

  /** Take this view to `spot`; a follow rides along to the next page. */
  const goTo = (spot: PresenceSpot, following: string | null): void => {
    if (samePage(spot, deps.here())) {
      deps.show(spot);
      return;
    }
    const href = spotHref(deps.workspaceId, spot);
    if (following) write({ key: following, arriving: href });
    deps.go(href);
  };
  const refresh = (): void => {
    if (!current) return;
    const spot = spotOfParticipant(deps.room.getStates(), current, deps.room.clientID);
    if (!spot) return;
    const sig = spotKey(spot);
    if (sig === applied) return;
    applied = sig;
    goTo(spot, current);
  };

  deps.room.on('change', refresh);

  return {
    key: () => current,
    follow(key) {
      current = key;
      applied = null;
      write(key ? { key } : null);
      deps.onChange?.(key);
      refresh();
    },
    jump(key) {
      const spot = spotOfParticipant(deps.room.getStates(), key, deps.room.clientID);
      if (spot) goTo(spot, null);
    },
    refresh() {
      applied = null;
      refresh();
    },
  };
}

/**
 * End the follow when the reader moves on their own. A press on the presence
 * strip is how a follow is armed and changed, so it is not one of these.
 */
export function stopOnOwnInput(
  target: Pick<EventTarget, 'addEventListener'>,
  follower: Follower,
  isStrip: (el: EventTarget | null) => boolean,
): void {
  const stop = (ev: Event): void => {
    if (!follower.key() || isStrip(ev.target)) return;
    follower.follow(null);
  };
  for (const name of ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const) {
    target.addEventListener(name, stop, { passive: true, capture: true });
  }
}
