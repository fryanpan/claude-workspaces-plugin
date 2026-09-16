/**
 * What `set_task_schedule` says back about the rule's OUTPUT FOLDER.
 *
 * A scheduled rule can declare the folder its runs write into (PR 968): each
 * run that writes files there files one Home review item linking them. The
 * field shipped, and no rule declared one until somebody was told by hand —
 * because nothing in the verb's own answer said the field existed. So the
 * answer says it, both ways round: a rule that declares a folder gets it
 * echoed with what that buys, and a rule that declares none gets one sentence
 * naming the field.
 *
 * A module of its own for the reason `scheduled-line.ts` and `nudge-line.ts`
 * are: the wording is a decision that has to be assertable without starting
 * an MCP server.
 */

/** The `output` field of a `set_task_schedule` answer. */
export interface ScheduleOutputLine {
  /** The declared folder, project-relative, or null when the rule declares
   *  none. Never absent: absent would read as "this server is too old to
   *  know", and this bundle always knows. */
  folder: string | null;
  /** What the folder does, or what declaring one would do. */
  note: string;
}

const NONE =
  'This rule declares no output folder. Pass output: {folder: "digests"} and every ' +
  'run that writes files there files ONE review item on Home linking them, which the ' +
  'next run replaces. Without it a run that writes files tells nobody it did.';

/**
 * Build the line. Takes the schedule the store handed back, so the answer
 * describes what is ARMED rather than what the caller sent.
 */
export function scheduleOutputLine(
  schedule: { output?: { folder?: string } | null } | null | undefined,
): ScheduleOutputLine {
  const folder = schedule?.output?.folder;
  if (typeof folder !== 'string' || folder.trim() === '') return { folder: null, note: NONE };
  return {
    folder,
    note:
      `Runs of this rule write into ${folder}. Every run that changes a file there files ` +
      'ONE review item on Home linking those files, and the next run replaces it. The ' +
      'folder is read relative to the board’s project root.',
  };
}
