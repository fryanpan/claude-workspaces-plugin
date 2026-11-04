/**
 * Which of the reader's tabs hears them, when listening is on in several.
 *
 * Bryan, 4 Nov: "it's fine to have listening turned on on multiple tabs. Um,
 * but only the tab that I'm actively on should be listening to me, or the
 * last one that I was on." So every tab with listening on writes, into one
 * `localStorage` record its origin shares, when the reader was last on it;
 * the one with the latest time hears and the others pause. Being on a tab
 * means turning listening on there, focusing it, showing it, or tapping in
 * it. A tab the reader leaves for another app, or for a tab where listening
 * is off, keeps hearing, because no tab with listening on is newer.
 *
 * Each tab reads the record again whenever another tab writes it (the
 * `storage` event), so a change reaches every tab without a timer. A tab
 * takes its line out as it unloads. One that dies without unloading would
 * hold the floor for good, so each line is refreshed every `SEEN_MS` and a
 * line not refreshed for `STALE_MS` is ignored. That window is long because
 * Chrome runs a hidden tab's timers as rarely as once a minute.
 *
 * With no storage (a private window that refuses it), every tab hears, as
 * before this module existed.
 */

export const LISTENING_TABS_KEY = 'cw.lead-chat.listening-tabs';
/** How often a listening tab says it is still there. */
export const SEEN_MS = 10_000;
/** How long a line may go unrefreshed before its tab counts as gone. */
export const STALE_MS = 150_000;

interface Line {
  /** When the reader was last on this tab. */
  on: number;
  /** When this tab last said it is still there. */
  seen: number;
}
type Record_ = Record<string, Line>;

type Events = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export interface ListeningTabOpts {
  /** Called when this tab starts or stops being the one that hears. */
  onChange(hears: boolean): void;
  /** The record's home; omitted, this origin's `localStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Where focus, unload and `storage` events arrive; omitted, `window`. */
  win?: Events;
  /** Where visibility changes and taps arrive; omitted, `document`. */
  doc?: Events & { visibilityState: DocumentVisibilityState };
  now?: () => number;
  /** This tab's name in the record; omitted, a random one. */
  id?: string;
}

export interface ListeningTab {
  /** Listening went on here: this tab is the one the reader is on. */
  join(): void;
  /** Listening went off here. */
  leave(): void;
  /** This tab hears: it is the newest in the record, or not in it. */
  hears(): boolean;
  destroy(): void;
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function createListeningTab(opts: ListeningTabOpts): ListeningTab {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const win = opts.win ?? window;
  const doc = opts.doc ?? document;
  const now = opts.now ?? Date.now;
  const id = opts.id ?? `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let joined = false;
  let hearing = true;
  let beat: ReturnType<typeof setInterval> | null = null;

  const readAll = (): Record_ => {
    try {
      const raw = storage?.getItem(LISTENING_TABS_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return parsed && typeof parsed === 'object' ? (parsed as Record_) : {};
    } catch {
      return {};
    }
  };
  /** The record with this tab's line changed by `edit`, and stale lines out. */
  const write = (edit: (all: Record_) => void): void => {
    if (!storage) return;
    const all = readAll();
    const cutoff = now() - STALE_MS;
    for (const [k, v] of Object.entries(all)) if (!(v?.seen >= cutoff)) delete all[k];
    edit(all);
    try {
      storage.setItem(LISTENING_TABS_KEY, JSON.stringify(all));
    } catch {}
  };

  const newest = (): string | null => {
    const cutoff = now() - STALE_MS;
    let best: [string, number] | null = null;
    for (const [k, v] of Object.entries(readAll())) {
      if (!(v?.seen >= cutoff) || typeof v.on !== 'number') continue;
      if (!best || v.on > best[1] || (v.on === best[1] && k > best[0])) best = [k, v.on];
    }
    return best ? best[0] : null;
  };

  const settle = (): void => {
    const winner = joined ? newest() : null;
    const next = winner === null || winner === id;
    if (next === hearing) return;
    hearing = next;
    opts.onChange(hearing);
  };

  /** The reader is on this tab now. */
  const claim = (): void => {
    if (!joined) return;
    const t = now();
    write((all) => {
      all[id] = { on: t, seen: t };
    });
    settle();
  };
  const stillHere = (): void => {
    write((all) => {
      const mine = all[id];
      all[id] = { on: mine?.on ?? 0, seen: now() };
    });
    settle();
  };
  const drop = (): void => {
    write((all) => {
      delete all[id];
    });
  };

  const onStorage = (e: Event): void => {
    const key = (e as StorageEvent).key;
    if (key === LISTENING_TABS_KEY || key === null) settle();
  };
  const onVisible = (): void => {
    if (doc.visibilityState === 'visible') claim();
  };
  /** Only a tap on a tab that does not hear needs writing down. */
  const onTap = (): void => {
    if (!hearing) claim();
  };
  const onHide = (): void => {
    if (joined) drop();
  };
  const onShow = (e: Event): void => {
    if ((e as PageTransitionEvent).persisted) claim();
  };
  win.addEventListener('storage', onStorage);
  win.addEventListener('focus', claim);
  win.addEventListener('pagehide', onHide);
  win.addEventListener('pageshow', onShow);
  doc.addEventListener('visibilitychange', onVisible);
  doc.addEventListener('pointerdown', onTap, true);

  const leave = (): void => {
    if (!joined) return;
    joined = false;
    if (beat) clearInterval(beat);
    beat = null;
    drop();
    settle();
  };

  return {
    join() {
      joined = true;
      if (!beat) beat = setInterval(stillHere, SEEN_MS);
      claim();
    },
    leave,
    hears: () => hearing,
    destroy() {
      leave();
      win.removeEventListener('storage', onStorage);
      win.removeEventListener('focus', claim);
      win.removeEventListener('pagehide', onHide);
      win.removeEventListener('pageshow', onShow);
      doc.removeEventListener('visibilitychange', onVisible);
      doc.removeEventListener('pointerdown', onTap, true);
    },
  };
}
