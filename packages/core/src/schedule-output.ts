/**
 * What a scheduled rule WRITES, and which of a run's files are its output
 * (docs/architecture/scheduled-tasks.md, "A run's output reaches Home").
 *
 * A rule that produces files — a daily digest is the case that asked for it —
 * declares the folder they land in. The board then knows a run's output
 * without guessing: the files in that folder whose bytes changed while the
 * run's instance was open. Pure, like the rest of the schedule arithmetic;
 * `task-run-output.ts` in the server is what lists the files and files the
 * item.
 *
 * Why a declaration rather than an inference. Every inference measured wrong
 * on a real daily digest run: a run writes its sources in one burst and its
 * digest four minutes later, so a burst rule splits one run in two and would
 * merge unrelated writes; a folder named like a digest is a guess about a
 * name; and the paths an agent writes in its instance's prose are content.
 * An agent filing the item itself fails silently, which is the failure the
 * feature replaces.
 */

/** Where a rule's output lands. */
export interface ScheduleOutput {
  /** POSIX, relative to the board's project root, no leading or trailing
   *  slash. Files in subfolders of it count too. */
  folder: string;
}

/** The Home item a run's output filed, and the files it links. */
export interface ScheduleOutputItem {
  id: string;
  /** Project-relative paths, newest first. */
  paths: string[];
  /** The linked files no doc of the board held when it was filed. The item
   *  is withdrawn once every one of them is opened; a run that only rewrote
   *  files already open waits for an answer or the next run instead. */
  waitingOn: string[];
}

/** What the server has done with the rule's output, on the rule's state. */
export interface ScheduleOutputState {
  /** The success whose run has been looked at. One look per success. */
  forSuccessAt: number;
  /** The item still standing for the rule, if one was filed. */
  item?: ScheduleOutputItem;
}

/**
 * How long after the instance closes a file still counts as its run's, and
 * how long the server waits before looking. A digest measured on a real run
 * landed 17s before its instance closed; a minute covers a writer that flushes
 * after reporting done.
 */
export const OUTPUT_SLACK_MS = 60_000;

/** The most files one item links. A week of daily digests nobody opened. */
export const OUTPUT_ITEM_MAX_LINKS = 7;

/** A folder longer than this is not one a person declared. */
export const OUTPUT_FOLDER_MAX_CHARS = 512;

export type ScheduleOutputParse =
  | { ok: true; output: ScheduleOutput | null | undefined }
  | { ok: false; error: string };

/**
 * A caller's `output` into a declaration. `undefined` means the caller said
 * nothing (keep what is stored), `null` clears, and an object is checked:
 * the folder is resolved against a root the server chose, so anything that
 * could climb out of it or name the root itself is refused rather than
 * cleaned up.
 */
export function parseScheduleOutput(raw: unknown): ScheduleOutputParse {
  if (raw === undefined) return { ok: true, output: undefined };
  if (raw === null) return { ok: true, output: null };
  const folder = (raw as { folder?: unknown } | undefined)?.folder;
  const refuse = {
    ok: false as const,
    error:
      'output.folder must be a relative folder inside the project, e.g. "digests" — no leading slash, no "." or ".." segments',
  };
  if (typeof raw !== 'object' || typeof folder !== 'string') return refuse;
  const trimmed = folder.replace(/\/+$/, '');
  if (trimmed === '' || trimmed.length > OUTPUT_FOLDER_MAX_CHARS) return refuse;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (trimmed.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(trimmed)) return refuse;
  if (trimmed.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return refuse;
  return { ok: true, output: { folder: trimmed } };
}

/** Is this project-relative path inside the declared folder? */
export function inOutputFolder(relPath: string, output: ScheduleOutput): boolean {
  return relPath.startsWith(`${output.folder}/`);
}

/**
 * The run's output: files in the folder whose mtime falls between the
 * instance's creation and its close plus the slack. Newest first. A file with
 * no clock is not claimed — nothing says it belongs to this run.
 */
export function runOutputPaths(
  files: readonly { relPath: string; at?: number }[],
  output: ScheduleOutput,
  run: { from: number; closedAt: number },
): string[] {
  return files
    .filter(
      (f) =>
        f.at !== undefined &&
        f.at >= run.from &&
        f.at <= run.closedAt + OUTPUT_SLACK_MS &&
        inOutputFolder(f.relPath, output),
    )
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.relPath.localeCompare(b.relPath))
    .map((f) => f.relPath);
}

/**
 * What the next item links: this run's files, then the files an earlier item
 * linked that nobody has opened, capped. The item replaces its predecessor, so
 * a morning's digest never buries yesterday's under a second card.
 */
export function outputItemPaths(fresh: readonly string[], carried: readonly string[]): string[] {
  const out = [...fresh];
  for (const p of carried) if (!out.includes(p)) out.push(p);
  return out.slice(0, OUTPUT_ITEM_MAX_LINKS);
}

/**
 * The `output` a write stores: what the caller said, or — when it said
 * nothing — what was already there. `null` clears. The phrase editor rewrites
 * the whole rule without knowing about outputs, so an absent field that
 * cleared would stop a digest reaching Home on every chip edit.
 */
export function scheduleOutputField(
  said: ScheduleOutput | null | undefined,
  stored: ScheduleOutput | undefined,
): { output?: ScheduleOutput } {
  const output = said === undefined ? stored : (said ?? undefined);
  return output ? { output } : {};
}
