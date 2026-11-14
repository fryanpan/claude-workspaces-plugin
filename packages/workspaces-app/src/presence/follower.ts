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
import {
  DIRECTIVE_FIELD,
  type PresenceSpot,
  parseDirective,
  parseSpot,
  samePage,
} from '@claude-workspaces/core/workspace-presence';
import {
  type RoomStates,
  isBoardPagePath,
  spotHref,
  spotKey,
  spotOfParticipant,
} from './follow-model.ts';

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

/**
 * The newest instruction the server addressed to THIS page (`show_person`),
 * or null. The server writes one at a time and addresses it to the tab its
 * person is attending to, so every other page reads past it. Only a state
 * with no `user` can carry one: the server's own state has none, and the
 * server stamps a `user` on every state a page sends.
 */
export function directiveFor(
  states: RoomStates,
  clientID: number,
): { seq: number; spot: PresenceSpot } | null {
  let best: { seq: number; spot: PresenceSpot } | null = null;
  states.forEach((raw, id) => {
    if (id === clientID) return;
    const state = raw as Record<string, unknown> | undefined;
    if (state?.user !== undefined) return;
    const d = parseDirective(state?.[DIRECTIVE_FIELD]);
    if (d && d.to === clientID && (!best || d.seq > best.seq)) best = { seq: d.seq, spot: d.spot };
  });
  return best;
}

interface Stored {
  key: string;
  /** The address the follow is sending this tab to, until it lands. */
  arriving?: string;
}

export const followStorageKey = (workspaceId: string): string => `cw-follow:${workspaceId}`;

/** Where an agent's directive sent this tab, until the page there loads. */
export const directedStorageKey = (workspaceId: string): string => `cw-directed:${workspaceId}`;

function readDirected(
  storage: FollowStorage,
  slot: string,
): { arriving: string; spot: PresenceSpot } | null {
  try {
    const v = JSON.parse(storage.getItem(slot) ?? 'null') as { arriving?: unknown; spot?: unknown };
    const spot = parseSpot(v?.spot);
    return v && typeof v.arriving === 'string' && spot ? { arriving: v.arriving, spot } : null;
  } catch {
    return null;
  }
}

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

  const directedSlot = directedStorageKey(deps.workspaceId);
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

  /** Take this view to `spot`; a follow rides along to the next page, and
   *  so does the place an agent sent this tab to (`directed`). */
  const goTo = (spot: PresenceSpot, following: string | null, directed = false): void => {
    // A board spot names its page by address: the board shows its own tabs
    // and panels in place, and anything else is another page. The queue and
    // the workspaces list hold a follow but draw none of them.
    const same =
      spot.surface === 'board'
        ? isBoardPagePath(deps.workspaceId, deps.address()) &&
          (!spot.path || isBoardPagePath(deps.workspaceId, spot.path))
        : samePage(spot, deps.here());
    const href = spotHref(deps.workspaceId, spot);
    // The queue and the list are a page of their own, so they are not `same`,
    // and loading the address already open would repeat on every load.
    if (same || href === deps.address()) {
      deps.show(spot);
      return;
    }
    if (following) write({ key: following, arriving: href });
    if (directed) deps.storage.setItem(directedSlot, JSON.stringify({ arriving: href, spot }));
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

  // An agent sending this tab somewhere: obeyed once, like a jump. A new
  // page has a new client id, so nothing addressed to its predecessor
  // reaches it.
  let directiveSeq = 0;
  const obey = (): void => {
    const d = directiveFor(deps.room.getStates(), deps.room.clientID);
    if (!d || d.seq <= directiveSeq) return;
    directiveSeq = d.seq;
    goTo(d.spot, null, true);
  };
  // Arrived where an agent sent this tab: show the place on this page once.
  const arrived = readDirected(deps.storage, directedSlot);
  if (arrived) {
    deps.storage.removeItem(directedSlot);
    if (arrived.arriving === deps.address()) deps.show(arrived.spot);
  }

  deps.room.on('change', refresh);
  deps.room.on('change', obey);

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
 * strip is how a follow is armed and changed, so it is not one of these; nor
 * is talking to the agent through its button or chat (`data-lead-chat`, the
 * shadow host an event inside it is retargeted to), which is how a person
 * following the lead asks it where to go next.
 */
export function stopOnOwnInput(
  target: Pick<EventTarget, 'addEventListener'>,
  follower: Follower,
  isStrip: (el: EventTarget | null) => boolean,
): void {
  const inAgentChat = (el: EventTarget | null): boolean =>
    // Duck-typed: the target may be a text node or a non-DOM EventTarget.
    !!(el as { closest?: (s: string) => unknown } | null)?.closest?.('[data-lead-chat]');
  const stop = (ev: Event): void => {
    if (!follower.key() || isStrip(ev.target) || inAgentChat(ev.target)) return;
    follower.follow(null);
  };
  for (const name of ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const) {
    target.addEventListener(name, stop, { passive: true, capture: true });
  }
}
