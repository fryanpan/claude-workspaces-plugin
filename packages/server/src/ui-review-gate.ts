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
 * WHAT IT DECIDES, AND FROM WHAT. Four reads, all of them explicit state:
 * who filed the row, whether it is in flight, **which files its builder has
 * changed**, and whether any review item on it has been answered.
 *
 * THE FOURTH READ USED TO BE THE ROW'S PROSE, AND THAT IS THE DEFECT THIS
 * MODULE WAS REWRITTEN TO FIX. A thirteen-word list run over the title and
 * body flagged six rows across three boards in two days and was wrong every
 * time: "layout" out of the skill name `project-docs-layout`; "button" out of
 * a sentence saying which board control the filer had used; "panel" out of a
 * market-research note about respondent panels. One row was named six times,
 * the last of them after its work had merged and deployed, when there was no
 * build left to hold. The cost is not the minutes. It is that a flag which is
 * usually wrong stops being read, and the one real ungated UI row then
 * arrives in the same list as the noise.
 *
 * So the question is asked of the WORK. A row in flight with a registered
 * dispatch has a worktree, a worktree has a changed-file list, and a
 * changed-file list answers "does this touch a screen" as a fact rather than
 * as a reading of somebody's paragraph. Judging files also catches the miss
 * the word list could never catch by construction: a row that changes a
 * screen without saying so.
 *
 * AND WHEN THERE IS NO DIFF, IT SAYS NOTHING. A row nobody registered a
 * dispatch for, a worktree that is not a git repo, a builder that has written
 * nothing yet — the gate has no evidence, and the previous behaviour (guess
 * from the prose) is the behaviour with the measured 0-for-6 record. Silence
 * here is not a miss being accepted quietly: it is the module declining to
 * assert a fact it cannot see. The reasoning, and the two alternatives that
 * were weighed against it, are in
 * `docs/architecture/stall-check/criteria.md`.
 *
 * The prose match SURVIVES as colour, never as the verdict. A finding names
 * the changed file that made it one, and the word in the row's own prose that
 * agrees, when there is one — because the lead who could dismiss a false
 * positive in a second was the lead who had been told which token matched.
 */

/**
 * The words that make a row's prose READ as UI work. Whole words only, case
 * folded, with a small suffix set (`s`, `es`, `ing`) so a plural or a gerund
 * is the same word.
 *
 * No longer a verdict — see the header. It rides a finding the changed files
 * already decided, so that the line the lead reads says both what the builder
 * touched and what the row claimed to be about.
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
 * boolean so a finding can say WHICH word agreed with the diff — a lead
 * reading "matched: page" can weigh a finding in a second, where a bare flag
 * makes them re-read the ticket to guess.
 */
export function uiKeywordIn(text: string): string | undefined {
  const hit = UI_WORD_RE.exec(text);
  return hit?.[1]?.toLowerCase();
}

/**
 * Extensions that exist only to be seen. A change to one of these is a change
 * to a screen in every layout this has to read, which is why the list is the
 * strong half of the rule and the path list below is the weak half.
 */
export const UI_FILE_EXTENSIONS: readonly string[] = [
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.htm',
  '.svg',
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
];

/**
 * Directory names that name a client surface. Weaker than an extension — a
 * `.ts` file says nothing about itself — so a hit here is carried into the
 * finding by name, exactly like a matched keyword, and dismissible the same
 * way.
 */
export const UI_PATH_SEGMENTS: readonly string[] = [
  'ui',
  'client',
  'frontend',
  'web',
  'components',
  'views',
  'pages',
  'styles',
  'public',
  'static',
  'templates',
  'widget',
];

/**
 * …and a package or directory named THIS way is the client of something.
 * `packages/workspaces-app/src/board/board-cards.ts` is a screen and carries
 * no other signal: no UI extension, no bare `app` segment. A convention, and
 * the weakest rule here, which is why it is a short closed list.
 */
export const UI_PACKAGE_SUFFIXES: readonly string[] = [
  '-app',
  '-ui',
  '-web',
  '-client',
  '-frontend',
];

/**
 * A test is not a screen. Without this the `-app` rule reads every file under
 * a client package's `test/` as a UI change — measured as the ONLY
 * disagreement between this classifier and the repo's own client packages
 * over 150 merged commits, and five of five of them were a client test.
 */
const TEST_PATH_SEGMENTS: readonly string[] = ['test', 'tests', '__tests__', 'spec', 'fixtures'];
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Is this one changed path a change to something a person looks at? */
export function isUiFile(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const dirs = segments.slice(0, -1);
  const base = segments[segments.length - 1] ?? '';
  if (dirs.some((d) => TEST_PATH_SEGMENTS.includes(d)) || TEST_FILE_RE.test(base)) return false;
  if (UI_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  return dirs.some(
    (d) => UI_PATH_SEGMENTS.includes(d) || UI_PACKAGE_SUFFIXES.some((suf) => d.endsWith(suf)),
  );
}

/**
 * The first changed file that makes a change a UI change, or `undefined`.
 * The path rather than a boolean, for the reason `uiKeywordIn` returns the
 * word: the finding has to carry its own evidence.
 */
export function uiFileIn(files: readonly string[]): string | undefined {
  return files.find((f) => isUiFile(f));
}

/** One row, as the gate needs to read it. Every field is explicit state the
 *  caller resolved; this module reads no store and shells out to nothing. */
export interface UiGateRow {
  id: string;
  title: string;
  /** The description snapshot. Absent is the same as empty. Colour only —
   *  nothing here is decided from it. */
  body?: string;
  /** The row's creator is POSITIVELY placed as an agent by the roster or by
   *  a declared actor kind. An unplaceable creator is not an agent: this
   *  gate is about work agents filed for themselves, and guessing from a
   *  name is how a person's row becomes an agent's. */
  filedByAgent: boolean;
  /** In flight: in-progress with a registered dispatch, or an in-progress
   *  transition on the row. */
  dispatched: boolean;
  /**
   * Every file the row's builder has changed, and which starting line that
   * was measured from — or `undefined` when nobody could answer: no
   * registered dispatch, a worktree that is gone or is not a git repo, a git
   * that failed. `undefined` and `{ files: [] }` are NOT the same: the first
   * is no evidence and the row goes unjudged, the second is a readable
   * worktree that has changed nothing, which is evidence of no UI change.
   */
  changedWork?: ChangedWork;
  /** Any review item on the row or its thread carries an answer. One is
   *  enough — the gate asks that somebody was asked and answered, not that
   *  every item on the row is closed. */
  answeredReviewItem: boolean;
}

/**
 * What the builder changed, and the starting line it was measured from.
 * Structurally what `changedFilesInWorktree` returns; declared here because
 * this module is the one that decides from it and must not import the
 * adapter that runs git.
 */
export interface ChangedWork {
  files: readonly string[];
  /** `dispatch` is the commit this dispatch's worktree sat on when it was
   *  registered; `trunk` the default branch's merge base, which is what the
   *  read falls back to and which cannot tell this task's work from the work
   *  of whoever held the checkout before it. */
  from: 'dispatch' | 'trunk';
}

/** A row that was built without its gate. */
export interface UngatedUiRow {
  id: string;
  title: string;
  /** The changed file that made it UI work — the finding's evidence. */
  file: string;
  /** Which starting line that evidence was measured from. A finding off a
   *  `trunk` read is the weaker claim and says so, because a reader who
   *  cannot tell the two apart pays the investigation the gate exists to
   *  save. */
  from: 'dispatch' | 'trunk';
  /** The word in the row's own prose that agrees, when there is one. Absent
   *  on the rows the word list could never have caught, which is most of the
   *  reason the gate now reads files. */
  keyword?: string;
}

/**
 * The rows in flight that an agent filed, whose builder has touched a screen,
 * and that nobody answered a review item on. Board order in, board order out.
 *
 * A row with no `changedWork` is skipped in silence — see the header.
 */
export function ungatedUiRows(rows: readonly UiGateRow[]): UngatedUiRow[] {
  const out: UngatedUiRow[] = [];
  for (const row of rows) {
    if (!row.filedByAgent || !row.dispatched || row.answeredReviewItem) continue;
    if (row.changedWork === undefined) continue;
    const file = uiFileIn(row.changedWork.files);
    if (file === undefined) continue;
    const keyword = uiKeywordIn(`${row.title}\n${row.body ?? ''}`);
    out.push({
      id: row.id,
      title: row.title,
      file,
      from: row.changedWork.from,
      ...(keyword !== undefined ? { keyword } : {}),
    });
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
  /**
   * What has this row's builder changed? `undefined` for a row with no
   * readable worktree. The intended answer is the dispatch registry's
   * worktree path through `changedFilesInWorktree` in `git-diff.ts`; it
   * shells out to git, so the gate asks it only of rows the two boolean
   * reads have already kept.
   */
  changedWork: (taskId: string) => ChangedWork | undefined;
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
 *
 * The two expensive reads are asked LAST and only of a row the cheap ones
 * have not already cleared. `changedWork` spawns a git process and
 * `answeredReviewItem` walks a doc's threads; doing either on every
 * in-progress row of every board on every stall tick, to learn something
 * about rows that were never candidates, is a cost with no reader.
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
    const candidate = filedByAgent && dispatched;
    const changedWork = candidate ? reads.changedWork(task.id) : undefined;
    const touchesUi = changedWork !== undefined && uiFileIn(changedWork.files) !== undefined;
    rows.push({
      id: task.id,
      title: task.title,
      ...(task.body !== undefined ? { body: task.body } : {}),
      filedByAgent,
      dispatched,
      ...(changedWork !== undefined ? { changedWork } : {}),
      answeredReviewItem: touchesUi ? reads.answeredReviewItem(task.id) : false,
    });
  }
  return ungatedUiRows(rows);
}
