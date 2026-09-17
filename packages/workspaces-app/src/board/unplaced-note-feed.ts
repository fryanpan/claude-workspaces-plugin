/**
 * The end-of-turn notes no task took, as rows of the board's Activity tab.
 *
 * WHY THIS EXISTS. The Stop hook posts every end-of-turn message to the
 * server, which pins it to the agent's row only when that agent holds exactly
 * one in-progress row it owns on the board. Holding two or more it refuses to
 * guess, and refusing is right — the old newest-claim guess measured wrong
 * about three times in four. The refused note is appended to the board's own
 * sidecar (`agent-note-log.ts` on the server), which made it survive a
 * restart and showed it to nobody. So on a board where one session holds
 * several rows, every end-of-turn message existed and no surface rendered it.
 *
 * WHY HERE AND NOT ON A TASK. There is no task. The Home pane groups by task
 * and the panel's Activity tab is one task's history; neither can hold a row
 * that names none. The board's Activity tab is a flat list ordered by time,
 * which is the one shape an unplaced note fits.
 *
 * WHAT IT IS NOT. Not a board event: it never entered `events.jsonl`, and the
 * four consumers of that trail each carry their own exclusion list a new
 * event type would have to be added to. It arrives beside `events` on the
 * wire and is merged into the feed here, by the only consumer that wants it.
 *
 * Pure functions over the two lists — no DOM, no fetch — so the ordering, the
 * filter rule and every phrase the tab prints are testable without a browser.
 */
import { firstLine } from './activity-model.ts';
import { type ActivityEvent, type ActivityFilter, activityRows } from './board-presence-model.ts';

/** One line of the server's unplaced-note log, as the events read sends it.
 *  Mirrors `LoggedAgentNote` minus the fields a reader has no use for — the
 *  client cannot import server code, same as `ActivityEvent`. */
export interface UnplacedNote {
  agent: string;
  kind: 'turn' | 'denial' | 'status';
  text: string;
  at: number;
  /** True when the note faced SEVERAL candidate rows, false when it faced
   *  none. Both are unplaced; this is the why, and it is the first question a
   *  reader has about a row that names no task. */
  ambiguous: boolean;
}

/** A row of the tab: an audit event, or a note no task took. Discriminated on
 *  `row` so the render has no field-sniffing to do, and carrying `at` on both
 *  so one sort orders the merged list. */
export type ActivityRow =
  | { row: 'event'; at: number; event: ActivityEvent }
  | { row: 'unplaced'; at: number; note: UnplacedNote };

/** How many characters of a note the row's first line shows before the rest
 *  moves behind the expander. The tab is a feed; a whole end-of-turn message
 *  is up to four thousand characters and would push every neighbouring row
 *  off the screen. */
export const UNPLACED_LINE_CAP = 200;

/** What the note was, in the reader's words. `turn` is the Stop hook's
 *  end-of-turn message, which is the case this whole surface is for; the
 *  other two can also go unplaced and must not render as a blank. */
export function unplacedKindPhrase(kind: UnplacedNote['kind']): string {
  if (kind === 'denial') return 'blocked';
  if (kind === 'status') return 'status note';
  return 'end-of-turn note';
}

/**
 * The row's heading: who wrote it, what it was, and that no task took it.
 *
 * Three facts in one line because all three are the row's reason for being on
 * screen. The parenthesis is the WHY — an agent holding several rows is the
 * common case and reads very differently from one holding none.
 */
export function unplacedNoteLabel(note: UnplacedNote): string {
  const why = note.ambiguous ? 'several tasks open' : 'no task open';
  return `${note.agent} · ${unplacedKindPhrase(note.kind)} · no task took it (${why})`;
}

/**
 * The note split into what the row shows and what an expander holds.
 *
 * `rest` is undefined when the first line IS the whole note — the common
 * short message — so the render puts no expander on a row that has nothing
 * behind it. This tab is the only surface that carries an unplaced note, so
 * the full text has to be reachable here or it is not reachable at all.
 */
export function unplacedNoteBody(text: string): { line: string; rest?: string } {
  const line = firstLine(text, UNPLACED_LINE_CAP);
  const full = text.trim();
  return full === line ? { line } : { line, rest: full };
}

/**
 * The tab's rows: the audit trail's rows and the board's unplaced notes, one
 * list, newest first.
 *
 * Under `decisions` the notes are dropped. That filter is the rows where
 * somebody exercised placement judgment, and an unplaced note is the
 * opposite — a message no judgment was exercised on. Ties break events before
 * notes so one clock stamp cannot reorder the list between two repaints.
 */
export function activityFeed(
  events: ActivityEvent[],
  notes: UnplacedNote[],
  filter: ActivityFilter,
): ActivityRow[] {
  const rows: ActivityRow[] = activityRows(events, filter).map((event) => ({
    row: 'event' as const,
    at: event.ts,
    event,
  }));
  if (filter === 'all') {
    for (const note of notes) rows.push({ row: 'unplaced', at: note.at, note });
  }
  return rows.sort((a, b) => b.at - a.at || (a.row === b.row ? 0 : a.row === 'event' ? -1 : 1));
}
