/**
 * Who is on which page of an app, as one server holds it, and who each
 * viewer may see.
 *
 * Transport-free, like the room host. The app opens a presence connection
 * however it likes, decides who is on it with its own sign-in check and which
 * room (board) from the address, and feeds the core whatever the page
 * announces. The core keeps one entry per connection (a tab) and answers, for
 * each viewer, who is on their page and, where the app turns it on, who is
 * elsewhere.
 *
 * The rules every app gets:
 *   - **Identity and room come from the connection.** A page announces only
 *     its spot. A `user`, `room` or `board` in what it sends is ignored, so no
 *     page can appear as somebody else or on a board it did not open.
 *   - **A person is one spot**: their most recently active tab, the rule
 *     Workspaces' presence already follows (`workspace-presence.ts`).
 *   - **The app picks which pages have presence** (`hasPresence`). A person
 *     on a page without it is shown nowhere, and that page shows nobody.
 *   - **App-wide presence is the app's switch** (`appWide`). Off, a page
 *     shows only who is on it. On, it also shows who is elsewhere, but only
 *     people on a board the viewer has a role on: the app's role function
 *     decides, and it is asked about the subject's board, which the core took
 *     from the subject's connection.
 *   - **Updates past the rate limit are dropped**, per connection, and
 *     counted.
 *
 * What a spot is, and which page it is on, is the app's: Workspaces passes
 * its own `parseSpot` and a page key built like `samePage`.
 */
import { type Principal, ROOM_ID, type RoleFn } from './roles.ts';

export interface PresenceRate {
  /** Updates a connection may send in a burst. Default 10. */
  burst: number;
  /** Updates per second it earns back. Default 5. */
  perSecond: number;
}

export interface PresenceOptions<S> {
  /** Required: the app's role function. A null role refuses the connection,
   *  and hides a board's people from a viewer with no role on it. */
  role: RoleFn;
  /** Read a spot out of what a page sent, or null to refuse it. */
  parseSpot: (raw: unknown) => S | null;
  /** The page a spot is on, as a key: two spots on one page share it. */
  pageOf: (spot: S) => string;
  /** Which pages show presence. */
  hasPresence: (page: string) => boolean;
  /** Whether a page also shows who is elsewhere in the app. */
  appWide: boolean;
  rate?: Partial<PresenceRate>;
  now?: () => number;
}

/** One person as a viewer sees them. */
export interface PresencePerson<S> {
  id: string;
  name: string;
  roomId: string;
  page: string;
  spot: S;
  lastActive: number;
}

export interface PresenceView<S> {
  /** Others on the viewer's page, by name. Empty on a page without presence. */
  here: PresencePerson<S>[];
  /** Others elsewhere in the app that the viewer may see; empty unless the
   *  app turned app-wide presence on. */
  elsewhere: PresencePerson<S>[];
  /** Where the person this connection follows is, when it follows somebody
   *  the viewer may see. */
  leader: PresencePerson<S> | null;
}

export type PresenceUpdateResult = 'applied' | 'rate-limited' | 'bad-spot' | 'closed';

export interface PresenceConnection<S> {
  readonly roomId: string;
  readonly principal: Principal;
  /** Feed what the page announced: its spot, as the app's `parseSpot` reads. */
  update(raw: unknown): PresenceUpdateResult;
  /** Follow a person by id, from this connection (one tab) only; null stops. */
  follow(personId: string | null): void;
  /** What this connection's page should show now. */
  view(): PresenceView<S>;
  close(): void;
}

export type PresenceJoinResult<S> =
  | { ok: true; connection: PresenceConnection<S> }
  | { ok: false; error: 'bad-room' | 'no-role' };

export interface PresenceHub<S> {
  /** `onChange` is called after any change another connection may see. */
  join(req: {
    roomId: string;
    principal: Principal;
    onChange?: () => void;
  }): PresenceJoinResult<S>;
  /** Updates dropped by the rate limit, since the hub started. */
  droppedCount(): number;
}

interface Entry<S> {
  roomId: string;
  principal: Principal;
  spot: S | null;
  lastActive: number;
  tokens: number;
  refilledAt: number;
  following: string | null;
  onChange?: () => void;
}

export function createPresenceHub<S>(opts: PresenceOptions<S>): PresenceHub<S> {
  if (typeof opts?.role !== 'function') {
    throw new TypeError('createPresenceHub needs a role function: presence is scoped by it');
  }
  const now = opts.now ?? Date.now;
  const burst = opts.rate?.burst ?? 10;
  const perSecond = opts.rate?.perSecond ?? 5;
  const entries = new Set<Entry<S>>();
  let dropped = 0;

  const notifyOthers = (from: Entry<S>): void => {
    for (const e of entries) {
      if (e === from) continue;
      try {
        e.onChange?.();
      } catch {
        // One app callback failing does not stop the rest hearing.
      }
    }
  };

  /** Each person's most recently active tab with a spot on a presence page. */
  const latestByPerson = (): Map<string, Entry<S>> => {
    const out = new Map<string, Entry<S>>();
    for (const e of entries) {
      if (e.spot === null) continue;
      const prev = out.get(e.principal.id);
      if (!prev || e.lastActive >= prev.lastActive) out.set(e.principal.id, e);
    }
    for (const [id, e] of out) {
      if (e.spot === null || !opts.hasPresence(opts.pageOf(e.spot))) out.delete(id);
    }
    return out;
  };

  const asPerson = (e: Entry<S>): PresencePerson<S> => {
    const spot = e.spot as S;
    return {
      id: e.principal.id,
      name: e.principal.name ?? e.principal.id,
      roomId: e.roomId,
      page: opts.pageOf(spot),
      spot,
      lastActive: e.lastActive,
    };
  };

  /** Whether `viewer` may see somebody on `roomId`: the role function's call. */
  const maySee = (viewer: Entry<S>, roomId: string): boolean =>
    roomId === viewer.roomId || opts.role(viewer.principal, roomId) !== null;

  const viewFor = (viewer: Entry<S>): PresenceView<S> => {
    const myPage = viewer.spot === null ? null : opts.pageOf(viewer.spot);
    const pageShown = myPage !== null && opts.hasPresence(myPage);
    const here: PresencePerson<S>[] = [];
    const elsewhere: PresencePerson<S>[] = [];
    let leader: PresencePerson<S> | null = null;
    for (const [id, e] of latestByPerson()) {
      const sameRoom = e.roomId === viewer.roomId;
      const visible = sameRoom || (opts.appWide && maySee(viewer, e.roomId));
      if (id === viewer.following && visible) leader = asPerson(e);
      if (id === viewer.principal.id) continue;
      const person = asPerson(e);
      if (sameRoom && pageShown && person.page === myPage) here.push(person);
      else if (opts.appWide && pageShown && visible) elsewhere.push(person);
    }
    const byName = (a: PresencePerson<S>, b: PresencePerson<S>) =>
      a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    return { here: here.sort(byName), elsewhere: elsewhere.sort(byName), leader };
  };

  const takeToken = (e: Entry<S>): boolean => {
    const t = now();
    e.tokens = Math.min(burst, e.tokens + ((t - e.refilledAt) / 1000) * perSecond);
    e.refilledAt = t;
    if (e.tokens < 1) return false;
    e.tokens -= 1;
    return true;
  };

  return {
    join(req) {
      if (typeof req.roomId !== 'string' || !ROOM_ID.test(req.roomId)) {
        return { ok: false, error: 'bad-room' };
      }
      if (opts.role(req.principal, req.roomId) === null) return { ok: false, error: 'no-role' };
      const t = now();
      const entry: Entry<S> = {
        roomId: req.roomId,
        principal: req.principal,
        spot: null,
        lastActive: t,
        tokens: burst,
        refilledAt: t,
        following: null,
        ...(req.onChange ? { onChange: req.onChange } : {}),
      };
      entries.add(entry);
      let closed = false;
      const connection: PresenceConnection<S> = {
        roomId: req.roomId,
        principal: req.principal,
        update(raw) {
          if (closed) return 'closed';
          if (!takeToken(entry)) {
            dropped++;
            return 'rate-limited';
          }
          const spot = opts.parseSpot(raw);
          if (spot === null) return 'bad-spot';
          entry.spot = spot;
          entry.lastActive = now();
          notifyOthers(entry);
          return 'applied';
        },
        follow(personId) {
          if (closed) return;
          entry.following = typeof personId === 'string' && personId ? personId : null;
        },
        view() {
          return viewFor(entry);
        },
        close() {
          if (closed) return;
          closed = true;
          entries.delete(entry);
          notifyOthers(entry);
        },
      };
      return { ok: true, connection };
    },
    droppedCount() {
      return dropped;
    },
  };
}
