/**
 * Following somebody, in one tab: when the leader moves, this tab goes to
 * their page, and on that page to their place (scroll position, block).
 *
 * The page half, DOM-free. The server's presence view names where the
 * leader is (`PresenceView.leader`); this decides what the tab does about
 * it. A follow is armed in ONE tab: the key lives in that tab's own storage
 * (`sessionStorage` in a browser) and is sent on that tab's own presence
 * connection, so the reader's other tabs stay where they are. It outlives a
 * navigation the follow caused: before going, the tab writes the address it
 * is going to, and the page that loads there finds its own address in the
 * record and carries on. A page that loads anywhere else while a follow's
 * navigation is in flight was reached by the reader, so the follow ends.
 *
 * The app's part of the contract: call `readerMoved` on any move the reader
 * makes themselves (a scroll, a key, a tap, a link), before it navigates.
 * A navigation the app cancels is a move of the reader's too. Once a tab has
 * arrived, its record names only the leader, so a reload
 * keeps following; a navigation the app did not report would too.
 * Workspaces' follower (`workspaces-app/src/presence/follower.ts`) works the
 * same way and ends a follow on any tap or key.
 *
 * Places carry their board, so a follow can cross boards: the leader's board
 * is the one the server took from the leader's connection
 * (`PresencePerson.roomId`), never one a page wrote.
 */

/** A spot on one board. */
export interface FollowPlace<S> {
  roomId: string;
  spot: S;
}

export interface FollowStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FollowTabDeps<S> {
  /** The app's name for this follow record, one per app. */
  slot: string;
  storage: FollowStorage;
  /** This tab's address now. */
  address: () => string;
  /** Where this tab's view is now. */
  here: () => FollowPlace<S>;
  /** The page a spot is on, within its board. */
  pageOf: (spot: S) => string;
  /** The address a place's page opens at. */
  hrefOf: (place: FollowPlace<S>) => string;
  /** Two spots on one page are the same place on it (scroll, block). */
  samePlace: (a: S, b: S) => boolean;
  /** Open another page. */
  go: (href: string) => void;
  /** Move this page's view to a place on it. */
  show: (spot: S) => void;
  /** Tell the server who this tab follows, on its own connection. */
  send: (personId: string | null) => void;
}

export interface FollowTab<S> {
  /** Who this tab follows, or null. */
  leader(): string | null;
  /** Follow somebody, or stop with null. */
  follow(personId: string | null): void;
  /** The leader is here now: the server's `view().leader` (its `roomId` and
   *  `spot`), or null when the viewer may not see them. A follow stays armed
   *  while the leader is out of sight, and resumes when they come back. */
  leaderAt(place: FollowPlace<S> | null): void;
  /** A page that swaps in place has finished navigating: apply the newest
   *  place the leader reached while it was on the way. */
  arrived(): void;
  /** The reader moved on their own: the follow ends. */
  readerMoved(): void;
}

interface Record {
  leader: string;
  /** The address this tab was sent to, while a navigation is in flight. */
  arriving?: string;
}

export function createFollowTab<S>(deps: FollowTabDeps<S>): FollowTab<S> {
  const read = (): Record | null => {
    try {
      const v = JSON.parse(deps.storage.getItem(deps.slot) ?? 'null') as Partial<Record> | null;
      return v && typeof v.leader === 'string' && v.leader ? (v as Record) : null;
    } catch {
      return null;
    }
  };
  const write = (r: Record | null): void => {
    if (r) deps.storage.setItem(deps.slot, JSON.stringify(r));
    else deps.storage.removeItem(deps.slot);
  };

  let pending: FollowPlace<S> | null = null;
  // A follow survives only the navigation it caused.
  let current = read();
  if (current?.arriving !== undefined && current.arriving !== deps.address()) current = null;
  if (current) {
    current = { leader: current.leader };
    write(current);
    deps.send(current.leader);
  } else {
    write(null);
  }

  const tab: FollowTab<S> = {
    leader: () => current?.leader ?? null,
    follow(personId) {
      current = personId ? { leader: personId } : null;
      write(current);
      deps.send(current?.leader ?? null);
    },
    leaderAt(place) {
      if (!current || place === null) return;
      if (current.arriving !== undefined) {
        // A page that swaps in place (no reload) arrives here, not at boot.
        // Until it does, keep only the newest place and apply it on arrival.
        if (deps.address() !== current.arriving) {
          pending = place;
          return;
        }
        current = { leader: current.leader };
        write(current);
      }
      pending = null;
      const here = deps.here();
      if (place.roomId !== here.roomId || deps.pageOf(place.spot) !== deps.pageOf(here.spot)) {
        const href = deps.hrefOf(place);
        current = { leader: current.leader, arriving: href };
        write(current);
        deps.go(href);
        return;
      }
      if (!deps.samePlace(place.spot, here.spot)) deps.show(place.spot);
    },
    arrived() {
      const held = pending;
      if (held) tab.leaderAt(held);
    },
    readerMoved() {
      pending = null;
      if (!current) return;
      current = null;
      write(null);
      deps.send(null);
    },
  };
  return tab;
}
