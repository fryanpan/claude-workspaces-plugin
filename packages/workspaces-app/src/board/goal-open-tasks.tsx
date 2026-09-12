/**
 * The goal panel's list of the band's unfinished tasks.
 *
 * The goal panel is the only place a band can be archived, and on the iPad it
 * opens OVER the band. Until this list existed it showed a title, three fields,
 * a description and comments — nothing at all about the tasks — so a band
 * with three rows in progress and builders running looked, from the one view
 * where it could be thrown away, exactly like a band with nothing in it (Bryan,
 * 2026-09-12: *"it looked like the band was empty, so I archived it. If this
 * was tied to a task in flight, the task didn't show up and that's a
 * problem."*).
 *
 * Rows, not counts. The per-status breakdown this panel used to carry was
 * struck on 2026-08-24 as *"just not useful information"*, and it is not what
 * comes back: what a reader needs before archiving is WHICH work is live, and
 * a tap away from it. Done rows are left out — they are the history, and the
 * archive's confirmation still counts them — and so the section is absent
 * entirely when nothing is left open, which is the one case where "this band
 * looks empty" is true.
 *
 * Each row wears the board's own status ring rather than the word, the way the
 * Related Links blockers do, and in the band's own order, so the list reads as
 * the band it covers.
 */
import type { BoardSection, BoardTask } from './board-model.ts';
import { statusLabel } from './board-model.ts';

/**
 * The goal's band as the goal panel reads it: the band's rows plus the goal's
 * RULE rows, which `boardSections` moves out to Scheduled (a rule is not the
 * work, so the board lists it once, there). The panel is answering a
 * different question — what goes if this goal is archived — and the archive
 * cascade takes every task filed under the goal, rules included, so a list
 * that left them out would undercount exactly the rows the ask is about.
 *
 * The rules go after the band's rows rather than sorted in among them: on the
 * board a rule is ordered within Scheduled, not within the band, so there is
 * no band position to restore, and the work itself reads first.
 */
export function goalPanelSection(
  sections: BoardSection[],
  goalId: string,
): BoardSection | undefined {
  const band = sections.find((s) => s.id === goalId);
  if (!band) return undefined;
  const rules = sections.find((s) => s.isScheduled)?.tasks.filter((t) => t.goal === goalId) ?? [];
  return rules.length === 0 ? band : { ...band, tasks: [...band.tasks, ...rules] };
}

/** The section's rows that are not finished, in the order it holds them. */
export function openBandTasks(section: BoardSection): BoardTask[] {
  return section.tasks.filter((t) => t.status !== 'done');
}

export function GoalOpenTasks(props: {
  section: BoardSection;
  onOpenTask?: (task: BoardTask) => void;
}) {
  const open = openBandTasks(props.section);
  if (open.length === 0) return null;
  return (
    <>
      <h3 class="board-detail-subhead">Tasks</h3>
      <ul class="board-goal-tasks">
        {open.map((task) => (
          <li key={task.id}>
            <button
              type="button"
              class="board-goal-task"
              data-task-id={task.id}
              title={`${statusLabel(task.status)} — open this task`}
              aria-label={`${task.title} — ${statusLabel(task.status)}`}
              onClick={() => props.onOpenTask?.(task)}
            >
              <span
                class={`board-status-mark board-status-mark-${task.status} board-related-mark`}
                aria-hidden="true"
              />
              <span class="board-goal-task-title">{task.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
