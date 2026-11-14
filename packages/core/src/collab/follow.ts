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
 * record and carries on. A page that loads anywhere else was reached by the
 * reader, so the follow ends. Workspaces' follower
 * (`workspaces-app/src/presence/follower.ts`) works the same way.
 */

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
  here: () => S;
  pageOf: (spot: S) => string;
  /** The address a spot's page opens at. */
  hrefOf: (spot: S) => string;
  /** Two spots are the same place on a page (same scroll, same block). */
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
  /** The leader is here now: the server's `view().leader.spot`, or null
   *  when the viewer may no longer see them. */
  leaderAt(spot: S | null): void;
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

  return {
    leader: () => current?.leader ?? null,
    follow(personId) {
      current = personId ? { leader: personId } : null;
      write(current);
      deps.send(current?.leader ?? null);
    },
    leaderAt(spot) {
      if (!current || spot === null) return;
      if (current.arriving !== undefined) {
        // A page that swaps in place (no reload) arrives here, not at boot.
        if (deps.address() !== current.arriving) return;
        current = { leader: current.leader };
        write(current);
      }
      const here = deps.here();
      if (deps.pageOf(spot) !== deps.pageOf(here)) {
        const href = deps.hrefOf(spot);
        current = { leader: current.leader, arriving: href };
        write(current);
        deps.go(href);
        return;
      }
      if (!deps.samePlace(spot, here)) deps.show(spot);
    },
    readerMoved() {
      if (!current) return;
      current = null;
      write(null);
      deps.send(null);
    },
  };
}
