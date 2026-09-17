/**
 * What a session attaching to a board is told about its project's MOUNTED
 * FOLDERS — the same job `sentry-projects.ts` does for Sentry, and for the
 * same measured reason.
 *
 * The folder-mount pointer shipped in both board skills on 12 September 2026.
 * Three days later no lead had learned of mounts from their own path: a skill
 * is read once, near the start of a session, and a capability announced there
 * and nowhere else stays unused. `attach_agent` is the one call every session
 * makes at session start, so the answer says it.
 *
 * WHAT IT SAYS, AND WHY BOTH HALVES. A board whose project already serves
 * folders gets the count and the names — enough to reach for `list_mounts`
 * rather than wonder. A board with none gets one sentence naming the verb and
 * the one thing about it that is not obvious: a mount is a filesystem walk,
 * so `.gitignore` is not a privacy control. That sentence is the whole point
 * of the field. A session that does not know mounts exist cannot ask.
 *
 * Pure. The route hands in the folder names it read off the registry, which
 * keeps the wording assertable without a mount table, a git checkout or a
 * server.
 */

/** A board's mounts, as the attaching session is told them. */
export interface AttachMountsBrief {
  /** The project the board's docs sit in, or null when none does. */
  project: string | null;
  /** How many folders the project serves right now. */
  count: number;
  /**
   * The folders, repo-relative, the repo root spelled `.`.
   *
   * Absent — not empty — when a `local-only` project is answering a caller
   * off the box: the names are the first thing that would leave the machine,
   * exactly as the Library withholds them (`routes/workspace-library.ts`).
   * An empty array would read as "no folders", which is a different claim.
   */
  folders?: string[];
  /** What the reader should DO, in words. A bare count has been read as
   *  trivia before, which is the failure this whole field exists to end. */
  note: string;
}

/** The sentence a board with no mounted folder gets. Names the verb, and the
 *  one thing about mounting that surprises people. */
const NONE =
  'No folder of this project is mounted, so none of its files are on the board. ' +
  'mount_folder(path) mounts one: the server walks that folder on disk and serves ' +
  'every file under it at a link that survives a rewrite or a move. It is a ' +
  'filesystem walk, not a git listing — ignored and uncommitted files are served ' +
  'too, so .gitignore is not a privacy control. Mount a folder you would show the ' +
  'whole board, and use set_project_privacy for one whose bytes must stay on this ' +
  'machine.';

/** The sentence a board that already serves folders gets. */
function some(count: number, folders: string[] | undefined): string {
  const named = folders && folders.length > 0 ? ` (${folders.join(', ')})` : '';
  return (
    `This project serves ${count} mounted folder${count === 1 ? '' : 's'}${named}. ` +
    'list_mounts reads the table and mount_folder adds one. A mount is a filesystem ' +
    'walk, so ignored and uncommitted files under it are served too — .gitignore is ' +
    'not a privacy control.'
  );
}

export interface AttachMountsInput {
  /** The repo key of the project the board's docs sit in, or null. */
  repoKey: string | null;
  /** The live mounts' folders, repo-relative; the empty string is the root. */
  folders: readonly string[];
  /** May the folder names go out? False for a `local-only` project answering
   *  a caller that is not on this machine. */
  mayNameFolders: boolean;
}

/** Build the brief. Always answers: "none" is the case that needed saying. */
export function attachMountsBrief(input: AttachMountsInput): AttachMountsBrief {
  const count = input.folders.length;
  // The root is mounted as the empty string in the registry, which renders as
  // nothing at all in a list of names.
  const folders = input.folders.map((f) => (f === '' ? '.' : f));
  if (count === 0) return { project: input.repoKey, count: 0, note: NONE };
  if (!input.mayNameFolders) return { project: input.repoKey, count, note: some(count, undefined) };
  return { project: input.repoKey, count, folders, note: some(count, folders) };
}
