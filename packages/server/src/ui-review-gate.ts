/**
 * The UI gate: an agent-filed row that changes what a person sees on screen
 * must clear an ANSWERED review item before anyone builds it.
 *
 * The rule is written for builders and for the lead in the two board skills
 * (`working-in-a-workspace`, `leading-a-workspace`). This module is the half
 * that makes a breach VISIBLE: it names the rows that were dispatched without
 * the gate, so the lead's wake and the keep-moving verdict can carry them the
 * way they already carry a held review item.
 *
 * It exists because a rule nobody measures is a rule that holds until the
 * first busy afternoon. PR 662 moved the Plan and Review buttons onto the
 * task ticket — a visible change to every reader of the board — from a row an
 * agent had filed along the way, with no review item and nobody asked. The
 * work was fine; the fact that nothing anywhere could have noticed is not.
 *
 * WHAT IT DECIDES, AND FROM WHAT. Three of the four reads are explicit state
 * the store already holds — who filed the row, whether it is in flight,
 * whether any review item on it has been answered. The fourth, "is this a UI
 * change", is read out of the row's own words, and there is no honest way
 * around that: nothing on a task declares which surface it touches.
 *
 * So the keyword set below is deliberately SMALL and deliberately loose about
 * missing things. A miss costs what the board costs today — nothing noticed —
 * while a false positive costs the lead a wake about a row that never needed
 * the gate, and a class of finding that cries wolf is a class of finding
 * people learn to skip. The limits are written down in
 * `docs/architecture/stall-check/criteria.md`; the short version is that this
 * catches rows that SAY they are about a screen, and misses every row that
 * changes one without saying so.
 */

/**
 * The words that make a row read as UI work. Whole words only, case folded,
 * with a small suffix set (`s`, `es`, `ing`) so a plural or a gerund is the
 * same word.
 *
 * Every entry earns its place by naming a thing on a screen or the act of
 * touching one. Deliberately absent: "design", "view", "render", "style" and
 * "component", each of which is at least as common in server prose as in UI
 * prose on this board.
 */
export const UI_KEYWORDS: readonly string[] = [
  'button',
  'screen',
  'page',
  'layout',
  'mockup',
  'ui',
  'css',
  'tap',
  'banner',
  'indicator',
  'badge',
  'panel',
  'float',
];

const UI_WORD_RE = new RegExp(`\\b(${UI_KEYWORDS.join('|')})(?:s|es|ing)?\\b`, 'i');

/**
 * The first UI word in a row's text, or `undefined`. Returned rather than a
 * boolean so a finding can say WHICH word made it one — a lead reading
 * "matched: page" can dismiss a false positive in a second, where a bare
 * flag makes them re-read the ticket to guess.
 */
export function uiKeywordIn(text: string): string | undefined {
  const hit = UI_WORD_RE.exec(text);
  return hit?.[1]?.toLowerCase();
}

/** One row, as the gate needs to read it. Every field is explicit state the
 *  caller resolved; this module reads no store. */
export interface UiGateRow {
  id: string;
  title: string;
  /** The description snapshot. Absent is the same as empty. */
  body?: string;
  /** The row's creator is POSITIVELY placed as an agent by the roster or by
   *  a declared actor kind. An unplaceable creator is not an agent: this
   *  gate is about work agents filed for themselves, and guessing from a
   *  name is how a person's row becomes an agent's. */
  filedByAgent: boolean;
  /** In flight: in-progress with a registered dispatch, or an in-progress
   *  transition on the row. */
  dispatched: boolean;
  /** Any review item on the row or its thread carries an answer. One is
   *  enough — the gate asks that somebody was asked and answered, not that
   *  every item on the row is closed. */
  answeredReviewItem: boolean;
}

/** A row that was built without its gate. */
export interface UngatedUiRow {
  id: string;
  title: string;
  /** The word that made it read as UI work. */
  keyword: string;
}

/**
 * The rows in flight that an agent filed, that read as UI work, and that
 * nobody answered a review item on. Board order in, board order out.
 */
export function ungatedUiRows(rows: readonly UiGateRow[]): UngatedUiRow[] {
  const out: UngatedUiRow[] = [];
  for (const row of rows) {
    if (!row.filedByAgent || !row.dispatched || row.answeredReviewItem) continue;
    const keyword = uiKeywordIn(`${row.title}\n${row.body ?? ''}`);
    if (keyword === undefined) continue;
    out.push({ id: row.id, title: row.title, keyword });
  }
  return out;
}

/** The slice of a board row this gate reads. Narrower than `Task` on purpose:
 *  the module stays testable from literals and imports no store. */
export interface UiGateTask {
  id: string;
  title: string;
  body?: string;
  status: string;
  kind?: 'task' | 'goal';
  /** Display name of the filer, per the visitor contract. */
  createdBy?: string;
  transitions: ReadonlyArray<{ to: string; by?: { name?: string; kind?: string } }>;
}

/** What the caller has to answer that the row itself cannot. */
export interface UiGateReads {
  /**
   * Is this display name POSITIVELY an agent? The roster's `resolveAgentId`
   * is the intended answer: it returns an id for a name the roster placed as
   * an agent and null for everything else, so a person, an unknown name and a
   * blank all read as "not an agent" — which is the safe direction here.
   */
  isAgentName: (name: string) => boolean;
  /** Has any review item on this row, on either surface, been answered? */
  answeredReviewItem: (taskId: string) => boolean;
}

/**
 * Which rows on a board are in flight past the UI gate.
 *
 * `dispatched` is read as "in-progress AND somebody moved it there": the
 * status alone can be a row a person dragged across the board, and the
 * transition is the record that the move happened. A board that also keeps a
 * dispatch registry adds nothing here — a registered dispatch always writes
 * the transition it is registered against.
 */
export function collectUngatedUiRows(
  tasks: readonly UiGateTask[],
  reads: UiGateReads,
): UngatedUiRow[] {
  const rows: UiGateRow[] = [];
  for (const task of tasks) {
    if (task.kind === 'goal' || task.status !== 'in-progress') continue;
    const filer = task.createdBy?.trim() || task.transitions[0]?.by?.name?.trim() || '';
    const filedByAgent =
      (filer !== '' && reads.isAgentName(filer)) ||
      (task.createdBy === undefined && task.transitions[0]?.by?.kind === 'agent');
    const dispatched = task.transitions.some((t) => t.to === 'in-progress');
    rows.push({
      id: task.id,
      title: task.title,
      ...(task.body !== undefined ? { body: task.body } : {}),
      filedByAgent,
      dispatched,
      // Asked LAST and only of a row the three cheap reads have not already
      // cleared: the answer lives in a doc's threads, and walking every
      // in-progress row's body doc on every stall tick to learn something
      // about rows that were never candidates is a cost with no reader.
      answeredReviewItem:
        filedByAgent && dispatched && uiKeywordIn(`${task.title}\n${task.body ?? ''}`) !== undefined
          ? reads.answeredReviewItem(task.id)
          : false,
    });
  }
  return ungatedUiRows(rows);
}
