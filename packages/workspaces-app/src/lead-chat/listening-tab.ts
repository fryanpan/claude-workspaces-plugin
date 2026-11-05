/**
 * Which of the reader's tabs hears them, when listening is on in several.
 *
 * Bryan, 4 Nov: "it's fine to have listening turned on on multiple tabs. Um,
 * but only the tab that I'm actively on should be listening to me, or the
 * last one that I was on." So every tab with listening on keeps one
 * `localStorage` line, under its own key, saying when the reader was last on
 * it; the tab with the latest time hears and the others pause. Being on a
 * tab means turning listening on there while it shows, focusing it, or
 * showing it. A tab that is not showing never claims, so one that reloads in
 * the background does not take the reader from the tab they are on. A tab
 * the reader leaves for another app, or for a tab where listening is off,
 * keeps hearing, because no tab with listening on is newer.
 *
 * Each tab writes only its own key, so two tabs writing at once cannot undo
 * each other's claim. Each reads the lines again whenever another tab writes
 * (the `storage` event), so a change reaches every tab without a timer.
 *
 * A tab's id lives in `sessionStorage`, which a page move in the same tab
 * keeps: the next page writes the same line, so the move does not hand the
 * reader to another tab. As a page unloads its line is marked to lapse in
 * `GRACE_MS`, long enough for the next page to rewrite it; a tab that was
 * closed lapses then, and the next newest tab hears. A tab that dies without
 * unloading would hold the reader for good, so each line is refreshed every
 * `SEEN_MS` and one not refreshed for `STALE_MS` lapses. That window is long
 * because Chrome runs a hidden tab's timers as rarely as once a minute. A tab
 * that does not hear wakes itself when the line that beats it lapses.
 *
 * With no storage (a private window that refuses it), every tab hears, as
 * before this module existed.
 */

/** Each tab's line is this prefix and the tab's id. */
export const LISTENING_TAB_PREFIX = 'cw.lead-chat.listening-tab.';
/** Where a tab keeps its id across its own page moves. */
export const TAB_ID_KEY = 'cw.lead-chat.listening-tab-id';
/** How often a listening tab says it is still there. */
export const SEEN_MS = 10_000;
/** How long a line may go unrefreshed before its tab counts as gone. */
export const STALE_MS = 150_000;
/** How long an unloading page's line lasts, for the next page to take. */
export const GRACE_MS = 2_000;

interface Line {
  /** When the reader was last on this tab; 0 if never while it showed. */
  on: number;
  /** When the line lapses. */
  until: number;
}

type Events = Pick<Window, 'addEventListener' | 'removeEventListener'>;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export interface ListeningTabOpts {
  /** Called when this tab starts or stops being the one that hears. */
  onChange(hears: boolean): void;
  /** Where the lines live; omitted, this origin's `localStorage`. */
  storage?: Store | null;
  /** Where focus, unload and `storage` events arrive; omitted, `window`. */
  win?: Events;
  /** Where visibility changes arrive; omitted, `document`. */
  doc?: Events & { visibilityState: DocumentVisibilityState };
  now?: () => number;
  /** This tab's id; omitted, the one this tab kept, or a new one. */
  id?: string;
}

export interface ListeningTab {
  /** Listening went on here. */
  join(): void;
  /** Listening went off here. */
  leave(): void;
  /** This tab hears: its line is the newest, or it has none. */
  hears(): boolean;
  destroy(): void;
}

function store(get: () => Store): Store | null {
  try {
    return get();
  } catch {
    return null;
  }
}

function keptId(now: number): string {
  const fresh = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const session = store(() => window.sessionStorage);
  try {
    const kept = session?.getItem(TAB_ID_KEY);
    if (kept) return kept;
    session?.setItem(TAB_ID_KEY, fresh);
  } catch {}
  return fresh;
}

export function createListeningTab(opts: ListeningTabOpts): ListeningTab {
  const storage = opts.storage === undefined ? store(() => window.localStorage) : opts.storage;
  const win = opts.win ?? window;
  const doc = opts.doc ?? document;
  const now = opts.now ?? Date.now;
  const id = opts.id ?? keptId(now());
  const mine = LISTENING_TAB_PREFIX + id;
  let joined = false;
  /** The page has unloaded: its line is left to lapse, not taken out. */
  let unloading = false;
  let hearing = true;
  let on = 0;
  let beat: ReturnType<typeof setInterval> | null = null;
  let wake: ReturnType<typeof setTimeout> | null = null;

  const put = (until: number): void => {
    try {
      storage?.setItem(mine, JSON.stringify({ on, until } satisfies Line));
    } catch {}
  };
  const drop = (): void => {
    try {
      storage?.removeItem(mine);
    } catch {}
  };

  /** The live lines, by id; a lapsed one is taken out on the way. */
  const lines = (): Map<string, Line> => {
    const out = new Map<string, Line>();
    if (!storage) return out;
    const t = now();
    const keys: string[] = [];
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k?.startsWith(LISTENING_TAB_PREFIX)) keys.push(k);
      }
    } catch {
      return out;
    }
    for (const k of keys) {
      let line: Line | null = null;
      try {
        line = JSON.parse(storage.getItem(k) ?? 'null') as Line | null;
      } catch {}
      if (line && typeof line.on === 'number' && line.until > t) {
        out.set(k.slice(LISTENING_TAB_PREFIX.length), line);
      } else if (k !== mine) {
        try {
          storage.removeItem(k);
        } catch {}
      }
    }
    return out;
  };

  const settle = (): void => {
    if (wake) clearTimeout(wake);
    wake = null;
    let best: [string, Line] | null = null;
    if (joined) {
      for (const [k, v] of lines()) {
        if (!best || v.on > best[1].on || (v.on === best[1].on && k > best[0])) best = [k, v];
      }
    }
    const next = best === null || best[0] === id;
    // Beaten: look again when the line that beats this one lapses.
    if (best && !next) wake = setTimeout(settle, Math.max(0, best[1].until - now()));
    if (next === hearing) return;
    hearing = next;
    opts.onChange(hearing);
  };

  /** The reader is on this tab now, if it shows. */
  const claim = (): void => {
    if (!joined) return;
    if (doc.visibilityState === 'visible') on = now();
    put(now() + STALE_MS);
    settle();
  };
  const stillHere = (): void => {
    put(now() + STALE_MS);
    settle();
  };

  const onStorage = (e: Event): void => {
    const key = (e as StorageEvent).key;
    if (key === null || key.startsWith(LISTENING_TAB_PREFIX)) settle();
  };
  const onVisible = (): void => {
    if (doc.visibilityState === 'visible') claim();
  };
  const onHide = (): void => {
    unloading = true;
    if (joined) put(now() + GRACE_MS);
  };
  const onShow = (e: Event): void => {
    unloading = false;
    if ((e as PageTransitionEvent).persisted) claim();
  };
  win.addEventListener('storage', onStorage);
  win.addEventListener('focus', claim);
  win.addEventListener('pagehide', onHide);
  win.addEventListener('pageshow', onShow);
  doc.addEventListener('visibilitychange', onVisible);

  const leave = (): void => {
    if (!joined) return;
    joined = false;
    if (beat) clearInterval(beat);
    beat = null;
    if (!unloading) drop();
    settle();
  };

  return {
    join() {
      joined = true;
      // A page move keeps the time the last page wrote.
      on = Math.max(on, lines().get(id)?.on ?? 0);
      if (!beat) beat = setInterval(stillHere, SEEN_MS);
      claim();
    },
    leave,
    hears: () => hearing,
    destroy() {
      leave();
      if (wake) clearTimeout(wake);
      wake = null;
      win.removeEventListener('storage', onStorage);
      win.removeEventListener('focus', claim);
      win.removeEventListener('pagehide', onHide);
      win.removeEventListener('pageshow', onShow);
      doc.removeEventListener('visibilitychange', onVisible);
    },
  };
}
