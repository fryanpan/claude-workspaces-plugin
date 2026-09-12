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

/** The band's rows that are not finished, in the band's order. */
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
