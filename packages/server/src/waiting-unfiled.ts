/**
 * A note that asks a person for something does not count as the task moving.
 *
 * ── The distinction this rests on, because it looks like a reversal ──────
 *
 * Rebuild step 2 (2026-09-08) settled that **waiting is DECLARED, never
 * inferred**: a task is `blocked-on-owner` only while a filed item on the
 * person's queue excuses it, and the prose reader that used to recover a wait
 * from an agent's own words was removed. Nothing here undoes that. Reading a
 * note for a wait and then EXCUSING the task is what was removed, and it
 * stays removed — no bucket in `keep-moving.ts` is ever set from prose.
 *
 * What this module does is the opposite direction, and the asymmetry is the
 * whole point. An unfiled wait may not EXCUSE the clock either. Before this,
 * a note saying "waiting on <person>" was movement like any other, so an
 * agent that wrote one every turn reset its own stall clock forever and the
 * task never stalled — the third of the three mechanisms that let a fleet's
 * worth of asks die in chat. Refusing to let those words count as progress
 * needs no confidence that the wait is real: a false positive costs the task
 * one note's worth of credit on a clock that is already half an hour wide,
 * and the remedy in every case, real wait or not, is the same single call.
 * Guessing a wait to park a task needs to be RIGHT; refusing to be quietened
 * by one does not.
 *
 * ── What counts as such a note ──────────────────────────────────────────
 *
 * `detectAsk` in `unfiled-ask.ts`, unchanged and shared with the Stop hook's
 * live nudge. There is one reader of an agent's closing words on this server
 * and this is a second caller of it, not a second copy: a phrase family added
 * for the nudge is one this check sees on the same day, and the measured
 * error rates in `docs/architecture/unfiled-ask.md` describe both.
 */

import { detectAsk } from './unfiled-ask.ts';

/** The bucket a task carries once its own notes are the only thing that has
 *  been happening and they ask a person. Its own word, not one of
 *  `classifyOpenTasks`'s: the lead's move is to file the ask (or say there is
 *  none), which is neither the stall's "find somebody for this" nor the
 *  `blocked-on-owner-unfiled` row's "the board says a person owns this". */
export const WAITING_UNFILED_BUCKET = 'waiting-unfiled';

/** The shape `TaskRow.notes` and `Task.notes` share, narrowed to what this
 *  reads. Typed structurally so neither caller has to convert. */
export interface NoteLike {
  ts: number;
  text?: string;
  /** Carried by both callers' notes; this module does not read it. Any kind
   *  counts — an agent asking for a decision in a `status` note has asked. */
  kind?: string;
  agent?: string;
}

/** A transition as both the board rows and the task store spell it. */
interface TransitionLike {
  by?: { kind?: string; name?: string };
}

/** How many people's names the third-person wait check knows. Spliced into a
 *  regex by `detectAsk`, so it is bounded. */
export const OWNER_NAMES_CAP = 8;

/**
 * Who the PEOPLE are, from who has actually moved a task on this board —
 * the same derivation `unfiled-ask-filing.ts` makes, exported here so the two
 * callers cannot drift. Names rather than a constant, because a constant
 * would bake one deployment's owner into a public repo.
 *
 * Insertion-ordered and capped: the caller walks open tasks first, so a cap
 * that bites drops somebody dormant rather than somebody active.
 */
export function ownerNamesFrom(tasks: Iterable<{ transitions?: TransitionLike[] }>): string[] {
  const owners = new Map<string, string>();
  for (const task of tasks) {
    for (const t of task.transitions ?? []) {
      const name = t.by?.name?.trim() ?? '';
      if (t.by?.kind === 'person' && name !== '') owners.set(name.toLowerCase(), name);
    }
  }
  return [...owners.values()].slice(0, OWNER_NAMES_CAP);
}

/** What the newest run of notes on a task says about its clock. */
export interface NoteClock {
  /**
   * The newest note that does NOT ask a person — the only note timestamp the
   * stall clock may read. 0 when every note asks, or there are none.
   */
  newestPlainAt: number;
  /**
   * The newest ASKING note, when one sits above every plain note. Absent when
   * the task's newest note is ordinary work: a task that asked an hour ago
   * and has reported since is moving, and its old ask is the ordinary
   * `unfiled` finding's business, not this one.
   */
  askedAt?: number;
}

/**
 * Read a task's notes newest-first, stopping at the first that does not ask.
 *
 * Newest-first and short-circuiting for two reasons. It is the right answer —
 * an asking note above the newest plain one is the agent's LAST word, and a
 * plain note above an ask means the agent went back to work — and it is one
 * `detectAsk` call per task on the ordinary tick rather than one per note,
 * which is what makes this affordable on a loop that runs every minute over
 * every task on every board.
 *
 * Notes append in arrival order but carry the poster's own clock, so they are
 * sorted rather than reversed (`keep-moving.ts` takes a max for the same
 * reason).
 */
export function noteClockOf(notes: readonly NoteLike[], owners: readonly string[]): NoteClock {
  const sorted = [...notes]
    .filter((n) => typeof n.ts === 'number' && n.ts > 0)
    .sort((a, b) => b.ts - a.ts);
  let askedAt: number | undefined;
  for (const note of sorted) {
    if (detectAsk(note.text, owners).ask) {
      if (askedAt === undefined) askedAt = note.ts;
      continue;
    }
    return askedAt === undefined ? { newestPlainAt: note.ts } : { newestPlainAt: note.ts, askedAt };
  }
  return askedAt === undefined ? { newestPlainAt: 0 } : { newestPlainAt: 0, askedAt };
}

/**
 * Every task's note clock, by id — what `classifyOpenTasks` is handed so that
 * it never reads prose itself.
 *
 * Built by the caller that already holds the tasks (`stall-wiring.ts`), for
 * the same reason the review items are: the classifier stays a pure function
 * over state somebody else read.
 */
export function noteClocks(
  tasks: Iterable<{ id: string; notes?: readonly NoteLike[] }>,
  owners: readonly string[],
): Map<string, NoteClock> {
  const out = new Map<string, NoteClock>();
  for (const task of tasks) {
    const notes = task.notes ?? [];
    if (notes.length === 0) continue;
    out.set(task.id, noteClockOf(notes, owners));
  }
  return out;
}
