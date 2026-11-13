/**
 * A board's Library folders: the tree a person sorts the board's docs into.
 *
 * Folder membership is BOARD DATA. Two fields on the board record hold all of
 * it — the folders, and which folder each doc was put in — so filing a doc
 * never touches its file on disk, its path or its doc id. A doc on two boards
 * can sit in a different folder on each.
 *
 * One folder is built in: Meetings, where a board's meetings land without
 * anybody filing them. It exists whether or not it was ever stored, it can be
 * renamed, and it can be neither moved nor archived — it is where the next
 * meeting goes, so it must always be there.
 *
 * Archiving is a soft delete. The folder keeps its record with `archivedAt`
 * set, and nothing about the docs in it is rewritten: a doc whose folder (or
 * any folder above it) is archived reads as being in no folder, and
 * unarchiving puts every doc and subfolder back where it was.
 *
 * Every operation takes the board's folder state and returns a verdict,
 * mutating the state only when the verdict is `ok`. `tasks.ts` persists it and
 * tells the open Library (`updateLibraryFolders`). `filedFolder` is the one
 * reader that touches the disk, to ask whether a doc ever held a meeting.
 */
import { existsSync } from 'node:fs';
import type { DocMeta } from '@claude-workspaces/core';
import { meetingIndexPath } from './meetings.ts';

/** The built-in folder's id. Never minted for any other folder. */
export const MEETINGS_FOLDER_ID = 'meetings';
/** Its name until somebody renames it. */
export const MEETINGS_FOLDER_NAME = 'Meetings';
/** The longest folder name accepted. */
export const MAX_FOLDER_NAME = 80;
/** How many folders one board may hold, archived ones included. */
export const MAX_FOLDERS = 500;

export interface LibraryFolder {
  id: string;
  name: string;
  /** The folder it sits in, or null at the top level. */
  parentId: string | null;
  createdAt: number;
  /** Set when archived; absent while live. */
  archivedAt?: number;
  /** The built-in Meetings folder. */
  meetings?: true;
}

/** The two board fields this module reads and writes. */
export interface FolderState {
  libraryFolders?: LibraryFolder[];
  /**
   * docId → the folder it was put in. `''` is an explicit "no folder", which
   * matters for a meeting: without an entry a meeting reads as in Meetings.
   */
  docFolders?: Record<string, string>;
}

/** A folder as a reader is shown it: live, with the path of names to it. */
export interface FolderView {
  id: string;
  name: string;
  parentId: string | null;
  /** Names from the top level down, joined with `/`. */
  path: string;
  meetings?: true;
}

export type FolderError =
  | 'bad-name'
  | 'duplicate-name'
  | 'not-found'
  | 'not-archived'
  | 'built-in'
  | 'bad-parent'
  | 'too-many';

export type FolderResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: FolderError; message: string };

const builtIn = (): LibraryFolder => ({
  id: MEETINGS_FOLDER_ID,
  name: MEETINGS_FOLDER_NAME,
  parentId: null,
  createdAt: 0,
  meetings: true,
});

/** Every folder, archived ones included, with Meetings present. */
export function allFolders(s: FolderState): LibraryFolder[] {
  const stored = s.libraryFolders ?? [];
  return stored.some((f) => f.id === MEETINGS_FOLDER_ID) ? stored : [builtIn(), ...stored];
}

/** The stored list, with Meetings written into it so it can be changed. */
function storedFolders(s: FolderState): LibraryFolder[] {
  if (!s.libraryFolders) s.libraryFolders = [];
  if (!s.libraryFolders.some((f) => f.id === MEETINGS_FOLDER_ID)) {
    s.libraryFolders.unshift(builtIn());
  }
  return s.libraryFolders;
}

/** A folder is live when neither it nor any folder above it is archived. */
function liveIds(s: FolderState): Set<string> {
  const all = allFolders(s);
  const byId = new Map(all.map((f) => [f.id, f]));
  const live = new Set<string>();
  for (const f of all) {
    let at: LibraryFolder | undefined = f;
    const seen = new Set<string>();
    let ok = true;
    while (at) {
      if (at.archivedAt !== undefined || seen.has(at.id)) {
        ok = false;
        break;
      }
      seen.add(at.id);
      if (at.parentId === null) break;
      at = byId.get(at.parentId);
      if (!at) ok = false;
    }
    if (ok) live.add(f.id);
  }
  return live;
}

/** The live folders, each with its path, Meetings first then by name. */
export function liveFolders(s: FolderState): FolderView[] {
  const live = liveIds(s);
  const all = allFolders(s).filter((f) => live.has(f.id));
  const byId = new Map(all.map((f) => [f.id, f]));
  const pathOf = (f: LibraryFolder): string => {
    const names: string[] = [];
    let at: LibraryFolder | undefined = f;
    while (at) {
      names.unshift(at.name);
      at = at.parentId === null ? undefined : byId.get(at.parentId);
    }
    return names.join('/');
  };
  return all
    .map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      path: pathOf(f),
      ...(f.meetings ? { meetings: true as const } : {}),
    }))
    .sort((a, b) => (b.meetings ? 1 : 0) - (a.meetings ? 1 : 0) || a.path.localeCompare(b.path));
}

/**
 * The folder a doc is in, or null for none. An explicit entry wins; a doc
 * filed in a folder that has since been archived is in no folder; a meeting
 * nobody filed is in Meetings.
 */
export function folderOfDoc(s: FolderState, docId: string, isMeeting: boolean): string | null {
  const put = s.docFolders?.[docId];
  if (put !== undefined) {
    if (put === '') return null;
    return liveIds(s).has(put) ? put : null;
  }
  return isMeeting ? MEETINGS_FOLDER_ID : null;
}

/** A folder name as typed, cleaned, or the reason it cannot be one. */
export function cleanFolderName(raw: unknown): FolderResult<{ name: string }> {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (name === '') return bad('bad-name', 'A folder needs a name.');
  if (name.length > MAX_FOLDER_NAME) {
    return bad('bad-name', `A folder name is at most ${MAX_FOLDER_NAME} characters.`);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  if (/[\u0000-\u001f\u007f/]/.test(name)) {
    return bad('bad-name', 'A folder name cannot hold a slash or a control character.');
  }
  return { ok: true, name };
}

function bad(
  error: FolderError,
  message: string,
): { ok: false; error: FolderError; message: string } {
  return { ok: false, error, message };
}

/** The live folder named `name` beside where a folder would sit, if any. */
function clash(
  s: FolderState,
  parentId: string | null,
  name: string,
  except?: string,
): LibraryFolder | undefined {
  const live = liveIds(s);
  const lower = name.toLowerCase();
  return allFolders(s).find(
    (f) =>
      live.has(f.id) &&
      f.id !== except &&
      f.parentId === parentId &&
      f.name.toLowerCase() === lower,
  );
}

function clashMessage(s: FolderState, parentId: string | null, name: string): string {
  const where =
    parentId === null
      ? 'the top level'
      : (allFolders(s).find((f) => f.id === parentId)?.name ?? '');
  return `There is already a folder called "${name}" in ${where}.`;
}

/** A parent a folder may be placed in: the top level, or a live folder. */
function parentOk(s: FolderState, parentId: string | null): boolean {
  return parentId === null || liveIds(s).has(parentId);
}

export function createFolder(
  s: FolderState,
  input: { name: unknown; parentId?: string | null },
  opts: { now: number; newId: () => string },
): FolderResult<{ folder: LibraryFolder }> {
  const cleaned = cleanFolderName(input.name);
  if (!cleaned.ok) return cleaned;
  const parentId = input.parentId ?? null;
  if (!parentOk(s, parentId)) return bad('bad-parent', 'That folder is not on this board.');
  const other = clash(s, parentId, cleaned.name);
  if (other) return bad('duplicate-name', clashMessage(s, parentId, other.name));
  if (allFolders(s).length >= MAX_FOLDERS) {
    return bad('too-many', `A board holds at most ${MAX_FOLDERS} folders.`);
  }
  const folder: LibraryFolder = {
    id: opts.newId(),
    name: cleaned.name,
    parentId,
    createdAt: opts.now,
  };
  storedFolders(s).push(folder);
  return { ok: true, folder };
}

/** A live folder by id, from the stored list so it can be changed. */
function liveStored(s: FolderState, id: string): LibraryFolder | undefined {
  if (!liveIds(s).has(id)) return undefined;
  return storedFolders(s).find((f) => f.id === id);
}

export function renameFolder(
  s: FolderState,
  id: string,
  rawName: unknown,
): FolderResult<{ folder: LibraryFolder; from: string }> {
  const cleaned = cleanFolderName(rawName);
  if (!cleaned.ok) return cleaned;
  if (!liveIds(s).has(id)) return bad('not-found', 'No such folder on this board.');
  const current = allFolders(s).find((f) => f.id === id) as LibraryFolder;
  const other = clash(s, current.parentId, cleaned.name, id);
  if (other) return bad('duplicate-name', clashMessage(s, current.parentId, other.name));
  const folder = liveStored(s, id) as LibraryFolder;
  const from = folder.name;
  folder.name = cleaned.name;
  return { ok: true, folder, from };
}

export function moveFolder(
  s: FolderState,
  id: string,
  parentId: string | null,
): FolderResult<{ folder: LibraryFolder; from: string | null }> {
  if (id === MEETINGS_FOLDER_ID) {
    return bad('built-in', 'Meetings stays at the top level: new meetings land in it.');
  }
  if (!liveIds(s).has(id)) return bad('not-found', 'No such folder on this board.');
  if (!parentOk(s, parentId)) return bad('bad-parent', 'That folder is not on this board.');
  // Not into itself, and not into anything inside it.
  const byId = new Map(allFolders(s).map((f) => [f.id, f]));
  for (let at = parentId; at !== null; at = byId.get(at)?.parentId ?? null) {
    if (at === id) return bad('bad-parent', 'A folder cannot go inside itself.');
  }
  const current = byId.get(id) as LibraryFolder;
  const other = clash(s, parentId, current.name, id);
  if (other) return bad('duplicate-name', clashMessage(s, parentId, other.name));
  const folder = liveStored(s, id) as LibraryFolder;
  const from = folder.parentId;
  folder.parentId = parentId;
  return { ok: true, folder, from };
}

export function archiveFolder(
  s: FolderState,
  id: string,
  now: number,
): FolderResult<{ folder: LibraryFolder }> {
  if (id === MEETINGS_FOLDER_ID) {
    return bad('built-in', 'Meetings cannot be archived: new meetings land in it.');
  }
  const folder = liveStored(s, id);
  if (!folder) return bad('not-found', 'No such folder on this board.');
  folder.archivedAt = now;
  return { ok: true, folder };
}

export function unarchiveFolder(
  s: FolderState,
  id: string,
): FolderResult<{ folder: LibraryFolder }> {
  const folder = (s.libraryFolders ?? []).find((f) => f.id === id);
  if (!folder) return bad('not-found', 'No such folder on this board.');
  if (folder.archivedAt === undefined) return bad('not-archived', 'That folder is not archived.');
  // Back where it was, or at the top level when the folder it sat in is
  // itself gone.
  const parentId = parentOk(s, folder.parentId) ? folder.parentId : null;
  const other = clash(s, parentId, folder.name, id);
  if (other) return bad('duplicate-name', clashMessage(s, parentId, other.name));
  folder.parentId = parentId;
  folder.archivedAt = undefined;
  return { ok: true, folder };
}

/** Put a doc in a folder, or in none with null. */
export function setDocFolder(
  s: FolderState,
  docId: string,
  folderId: string | null,
): FolderResult<{ folderId: string | null }> {
  if (folderId !== null && !liveIds(s).has(folderId)) {
    return bad('not-found', 'No such folder on this board.');
  }
  if (!s.docFolders) s.docFolders = {};
  s.docFolders[docId] = folderId ?? '';
  return { ok: true, folderId };
}

/**
 * The folder `list_docs` names for a doc on this board, or null. A doc counts
 * as a meeting the way the Library counts it: a huddle, or a doc with a
 * meeting on record. The record is only looked for when nobody filed the doc.
 */
export function filedFolder(
  board: FolderState,
  meta: Pick<DocMeta, 'docId' | 'huddle'>,
  dataDir: string,
): { id: string; path: string } | null {
  const explicit = board.docFolders?.[meta.docId] !== undefined;
  const meeting =
    !explicit && (meta.huddle === true || existsSync(meetingIndexPath(dataDir, meta.docId)));
  const id = folderOfDoc(board, meta.docId, meeting);
  if (id === null) return null;
  const view = liveFolders(board).find((f) => f.id === id);
  return view ? { id, path: view.path } : null;
}
