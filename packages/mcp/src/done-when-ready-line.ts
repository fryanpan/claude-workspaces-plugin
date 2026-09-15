/**
 * How `workspace.done_when_ready` reads to the agent it wakes.
 *
 * The server sends it once a task's every other done-when line is met and a
 * line written as needing a person has not been handed over. The reader is
 * the builder (or, when the builder holds no stream, the lead on its behalf),
 * and the next act is one call: `report_done_when` with `owner` and a link.
 * Kept out of the channel switch for the reason `scheduled-line.ts` is — so
 * the wording can be asserted against the payload.
 */

/** The fields this line reads off the frame. */
export interface DoneWhenReadyPayload {
  taskId?: string;
  title?: string;
  lineId?: string;
  line?: string;
  url?: string;
  /** Present only when the frame reached the lead because the task's own
   *  agent held no stream: the assignee it is on behalf of. */
  forAssignee?: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function doneWhenReadyLine(p: DoneWhenReadyPayload): string {
  const task = p.title ? `"${truncate(p.title, 60)}" (${p.taskId ?? '?'})` : (p.taskId ?? 'a task');
  const line = p.line ? `"${truncate(p.line, 120)}"` : 'a line';
  const behalf = p.forAssignee ? ` (for ${p.forAssignee}, who is not listening)` : '';
  const link = p.url ? ` ${p.url}` : '';
  return `[workspace.done_when_ready] every done-when line on ${task} that you can meet is met; ${line} needs a person and nobody has asked them yet${behalf}.${link} When it is ready for them, call report_done_when(taskId: "${p.taskId ?? '?'}", lines: [{ id: "${p.lineId ?? '?'}", verdict: "owner", proof: [{ text, url }] }]) — that files their review item. Until then they see nothing.`;
}
