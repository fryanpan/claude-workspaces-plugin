/**
 * The Library folder tree's model: which folders sit where, which docs each
 * holds, and what a name may be. Pure, so the tree's rules are testable
 * without a DOM; `library-tree.ts` paints what this returns.
 *
 * The server decides every rule again (`packages/server/src/library-folders.ts`);
 * the checks here exist so a refusal reads inline, before a round trip.
 */
import {
  type LibraryFolder,
  type LibraryPayload,
  type LibraryRow,
  type LibrarySort,
  sortRows,
} from './library-model.ts';

/** The built-in folder's id. */
export const MEETINGS_FOLDER_ID = 'meetings';

/** Every row naming a board doc, meetings and files together, once each. */
export function boardDocRows(payload: LibraryPayload): LibraryRow[] {
  const seen = new Set<string>();
  const out: LibraryRow[] = [];
  for (const row of [...payload.meetings, ...payload.files]) {
    if (!row.docId || seen.has(row.docId)) continue;
    seen.add(row.docId);
    out.push(row);
  }
  return out;
}

/** Recent files: meetings and files in one list, in the chosen order. */
export function recentRows(payload: LibraryPayload, sort: LibrarySort): LibraryRow[] {
  return sortRows([...payload.meetings, ...payload.files], sort);
}

/** The folders directly inside `parentId` (null: the top level), Meetings
 *  first, then by name. */
export function childFolders(
  folders: readonly LibraryFolder[],
  parentId: string | null,
): LibraryFolder[] {
  return folders
    .filter((f) => f.parentId === parentId)
    .sort(
      (a, b) =>
        (b.meetings ? 1 : 0) - (a.meetings ? 1 : 0) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
}

/** The board docs filed directly in `folderId` (null: in no folder). */
export function docsIn(
  rows: readonly LibraryRow[],
  folderId: string | null,
  sort: LibrarySort,
): LibraryRow[] {
  return sortRows(
    rows.filter((r) => (r.folderId ?? null) === folderId),
    sort,
  );
}

/** How many docs a folder holds, its subfolders' included. */
export function countIn(
  folders: readonly LibraryFolder[],
  rows: readonly LibraryRow[],
  folderId: string,
): number {
  const inside = new Set([folderId]);
  for (const f of folders) if (isUnder(folders, f.id, folderId)) inside.add(f.id);
  return rows.filter((r) => r.folderId !== undefined && inside.has(r.folderId)).length;
}

/** Whether `id` sits anywhere below `ancestor`. */
export function isUnder(folders: readonly LibraryFolder[], id: string, ancestor: string): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const seen = new Set<string>();
  let at = byId.get(id)?.parentId ?? null;
  while (at !== null && !seen.has(at)) {
    if (at === ancestor) return true;
    seen.add(at);
    at = byId.get(at)?.parentId ?? null;
  }
  return false;
}

/** The folders from the top level down to `id`, `id` included. */
export function folderTrail(folders: readonly LibraryFolder[], id: string): LibraryFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: LibraryFolder[] = [];
  let at = byId.get(id);
  while (at && !out.includes(at)) {
    out.unshift(at);
    at = at.parentId === null ? undefined : byId.get(at.parentId);
  }
  return out;
}

/**
 * Why a name cannot be used for a folder in `parentId`, or null when it can.
 * `except` is the folder being renamed, which may keep its own name.
 */
export function folderNameProblem(
  folders: readonly LibraryFolder[],
  parentId: string | null,
  raw: string,
  except?: string,
): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name === '') return 'A folder needs a name.';
  if (name.includes('/')) return 'A folder name cannot hold a slash.';
  if (name.length > 80) return 'A folder name is at most 80 characters.';
  const lower = name.toLowerCase();
  const clash = folders.find(
    (f) => f.parentId === parentId && f.id !== except && f.name.toLowerCase() === lower,
  );
  if (!clash) return null;
  const where =
    parentId === null
      ? 'the top level'
      : (folders.find((f) => f.id === parentId)?.name ?? 'that folder');
  return `There is already a folder called “${clash.name}” in ${where}.`;
}
