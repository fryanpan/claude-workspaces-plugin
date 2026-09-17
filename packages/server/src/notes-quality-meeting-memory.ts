/**
 * WHICH meetings the quality filer remembers, how many of them, and how the
 * memory of a standing item survives the process.
 *
 * It came out of `notes-quality-filing.ts` when `filed` learned to outlive a
 * restart, because that turned one question into two: the filer's own
 * question is WHEN a reading reaches a person, and this one is WHAT is still
 * known about a meeting when a reading arrives. The filer owns the fields of
 * an entry; this module owns the entry's identity, its lifetime, and the two
 * places it is kept.
 *
 * TWO PLACES, AND ONLY ONE OF THEM SURVIVES. The map is this process's, and
 * it holds everything — the newest reading, the armed grace, the standing
 * item. The store beneath it (`notes-quality-filed-store.ts`) holds only the
 * part that matters after the process is gone: where the item went and what
 * it says. A restart therefore comes back knowing how to take an item back
 * and knowing nothing about a reading it never committed, which is exactly
 * the split that is wanted — an uncommitted reading belongs to a recording
 * leg that no longer exists.
 *
 * THE MAP IS CONSULTED FIRST AND THE STORE ONLY ON A MISS. A map entry is
 * this process's own newer truth; the record beneath it is the older copy of
 * the same thing, and reading it over the top of a live entry would undo a
 * withdrawal the board has already accepted.
 */

import type {
  NotesQualityFiledIds,
  NotesQualityFiledStore,
  NotesQualityFiledWhere,
} from './notes-quality-filed-store.ts';
import type { NotesQualityFileInput } from './notes-quality-review.ts';
import type { NotesQualityVerdict } from './notes-quality-verdict.ts';

/** What one meeting's entry holds while the process lives. */
export interface HeldMeeting {
  /** The newest reading of this meeting, whether or not it crossed a bar. */
  input?: NotesQualityFileInput;
  /** Where this meeting's one item went, once it has gone anywhere. */
  filed?: NotesQualityFiledWhere;
  /** The verdict that item currently carries, so a re-check reaching the
   *  same one does not re-judge it in front of its reader. Kept as the
   *  STRUCTURE rather than as the words: the rates in it are compared with a
   *  band against what the ITEM says — see `notes-quality-verdict.ts`. */
  verdict?: NotesQualityVerdict;
  /**
   * That a refusal has already been written down for this item.
   *
   * IT SILENCES THE LINE, NEVER THE ATTEMPT. A meeting that keeps stopping
   * clean asks the board once per leg, and the same refusal written once per
   * leg is noise. But a refusal is not necessarily permanent: `answered` is
   * the one that refuses here in practice, and its own message says to undo
   * the answer if it was a mistake — after which the item is withdrawable and
   * still carries a claim the meeting disproved. So the board is asked every
   * time and only the log line is held back.
   *
   * Deliberately NOT persisted: it suppresses a repeated log line, and one
   * extra line after a restart is the whole cost of leaving it behind.
   */
  withdrawRefusalSaid?: true;
  /** The resume grace, while one is armed. */
  timer?: unknown;
}

/**
 * How many meetings are remembered in this process. A filing is remembered so
 * a revision can find it, and nothing ever tells this module that a meeting
 * will not be resumed again, so the map needs a bound. Oldest out first; a
 * meeting that fell off is read back from the store if it has a record there,
 * and gets a fresh item if it has not — the safe direction, because an item
 * is never lost and at worst a very old one is duplicated.
 */
export const REMEMBERED_MEETINGS = 200;

/** The filer's memory of the meetings it has seen. */
export interface NotesQualityMeetingMemory {
  /** This meeting's entry, made if there is none — and hydrated from the
   *  store when the store remembers an item this process does not. */
  get(ids: NotesQualityFiledIds): HeldMeeting;
  /** This meeting's entry if there is one, and nothing if there is not. A
   *  leg ending on a meeting nothing has read is not a reason to make one. */
  peek(ids: NotesQualityFiledIds): HeldMeeting | undefined;
  /**
   * Write down where this meeting's item is and what it says.
   *
   * Called at the two moments the answer changes — a filing, and a revision
   * that rewrote the item — and never for a reading that was only held. A leg
   * that files nothing leaves nothing behind, because a record naming no item
   * can only mislead the process that reads it.
   */
  remember(ids: NotesQualityFiledIds, mem: HeldMeeting): void;
  /** The item is not standing any more: both halves of the memory of it go,
   *  so a later process does not revive a pointer to a retired ask. */
  forget(ids: NotesQualityFiledIds, mem: HeldMeeting): void;
  /** How many meetings are holding a reading. Diagnostics and tests. */
  heldCount(): number;
}

// JSON rather than a joined string: a docId is caller-supplied, so any
// separator a key picked could appear inside one and merge two meetings'
// memory into one.
const keyOf = (ids: NotesQualityFiledIds): string => JSON.stringify([ids.docId, ids.meetingId]);

export function createNotesQualityMeetingMemory(
  store?: NotesQualityFiledStore,
): NotesQualityMeetingMemory {
  const state = new Map<string, HeldMeeting>();

  /** Bring the map back under its bound, oldest first. */
  const evict = (keep: string): void => {
    // Oldest first: a Map iterates in insertion order, so the first key is
    // the meeting nothing has touched for longest.
    //
    // NEVER AN ENTRY STILL WAITING TO FILE. The bound exists to cap the
    // memory of where FINISHED meetings' items went; an entry holding a
    // FLAGGED reading, or holding a grace that has not fired, is the only
    // copy of an item nothing can recreate. Dropping one would lose it
    // silently, which is the failure this whole path exists to avoid, so the
    // map is allowed over its bound rather than evicting one.
    //
    // A CLEAN held reading is not that, and the distinction is what keeps
    // this bound honest now that every reading arrives here rather than only
    // the flagged ones. Losing one costs a withdrawal that does not happen —
    // the behaviour this path had before it could withdraw at all — while
    // pinning one costs memory for the life of the process. That matters
    // because a `file()` is not guaranteed a `legEnded`: the stop path runs
    // `notes.end()` before it knows whether there is a meeting record to
    // report a leg for (`meeting-protocol.ts`), so an entry can be left
    // holding a reading nothing will ever commit.
    let evicted = 0;
    for (const [oldestKey, oldest] of state) {
      if (state.size - evicted <= REMEMBERED_MEETINGS) break;
      if (oldestKey === keep) continue;
      if (oldest.timer !== undefined) continue;
      if (oldest.input !== undefined && oldest.input.report.flags.length > 0) continue;
      state.delete(oldestKey);
      evicted += 1;
    }
  };

  return {
    get(ids) {
      const key = keyOf(ids);
      const existing = state.get(key);
      if (existing) return existing;
      // An entry this process has never seen may still have an item standing
      // — filed by the process that restarted out from under the meeting.
      const remembered = store?.read(ids);
      const h: HeldMeeting = remembered
        ? {
            filed: remembered.filed,
            ...(remembered.verdict !== undefined ? { verdict: remembered.verdict } : {}),
          }
        : {};
      state.set(key, h);
      evict(key);
      return h;
    },
    peek: (ids) => state.get(keyOf(ids)),
    remember(ids, mem) {
      if (!mem.filed) return;
      store?.write(ids, {
        filed: mem.filed,
        ...(mem.verdict !== undefined ? { verdict: mem.verdict } : {}),
      });
    },
    forget(ids, mem) {
      mem.filed = undefined;
      mem.verdict = undefined;
      mem.withdrawRefusalSaid = undefined;
      store?.clear(ids);
    },
    heldCount: () => [...state.values()].filter((h) => h.input !== undefined).length,
  };
}
