import { posix } from 'node:path';

/**
 * Where a board's documents actually live, by type — the Library's "Where
 * files live" fold.
 *
 * It reads each doc's REAL location, never the configured one: a project that
 * named `docs/meetings` but whose meetings still sit in server storage must
 * read as it is, because the point is to earn trust in where things are before
 * anybody moves anything (Bryan's goal doc, 2026-09-12). The configured folders
 * are only what a location is COMPARED with, to flag the ones outside them.
 *
 * Pure: every filesystem answer arrives already read, so each rule is testable
 * over hand-built input. Nothing here ever emits a host path — a label is a
 * folder from the repo root, a project's name, or a fixed phrase.
 */

/** The three kinds of thing a board files. */
export type LibraryKind = 'meetings' | 'documents' | 'mockups';

export const LIBRARY_KINDS: readonly LibraryKind[] = ['meetings', 'documents', 'mockups'];

/** One location of one kind, as the fold lists it. */
export interface LibraryPlace {
  /** What rows name to say they live here (`LibraryRow.place`). */
  key: string;
  /** A folder from the repo root, a project's name, or a fixed phrase. */
  label: string;
  /** The label is a folder path, and is painted as one. */
  folder: boolean;
  /** What is wrong, or unset, about this location. */
  note?: string;
  /** The note flags a doc outside its type's configured folders. */
  stray: boolean;
}

export interface LibraryWhere {
  kind: LibraryKind;
  places: LibraryPlace[];
  /** The project names no folder for this kind — said, never left blank. */
  unset: boolean;
}

/** One board doc, as far as its location goes. */
export interface PlacedDoc {
  kind: LibraryKind;
  /** The bound host path, when it has one. Read here, never emitted. */
  sourceUrl?: string;
  /** The repo and repo-relative path its identity key names, when it has one. */
  repoKey?: string;
  relPath?: string;
  /** An absolute path that did not stat as a file. */
  fileMissing: boolean;
}

export interface PlacingContext {
  /** The server's own storage, spelled every way a bound path may spell it. */
  storageRoots: readonly string[];
  /** The board's project, or null when its docs sit in no repo. */
  projectRepoKey: string | null;
  /**
   * Whether the project's folders may be named to this caller. False for a
   * local-only project read off the box, where file names are already hidden:
   * its docs read "In the project" and no folder is compared or named.
   */
  projectVisible: boolean;
  /** The project's meetings folder, from the repo root, when it named one. */
  meetingsFolder?: string;
  /** The project's live mounts, from the repo root. */
  mountFolders: readonly string[];
  /** Another repo's name, or null when it may not be named here. */
  projectNameOf: (repoKey: string) => string | null;
}

export const STORED_BY_WORKSPACES = 'Stored by Workspaces';

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

/** Is `relPath` inside the repo-relative folder `folder` (`''` is the root)? */
const inFolder = (relPath: string, folder: string): boolean =>
  folder === '' || relPath === folder || relPath.startsWith(`${folder}/`);

/**
 * The folders a kind is configured to live in. Meetings: the meetings folder.
 * Documents: the mounts, minus the meetings folder — a meetings folder is
 * usually mounted too, and a document filed there is not where documents go.
 * Mockups: nothing, because nothing names a mockup's home.
 */
export function configuredFolders(kind: LibraryKind, ctx: PlacingContext): string[] {
  if (!ctx.projectRepoKey || !ctx.projectVisible) return [];
  if (kind === 'meetings') return ctx.meetingsFolder === undefined ? [] : [ctx.meetingsFolder];
  if (kind === 'documents') return ctx.mountFolders.filter((f) => f !== ctx.meetingsFolder);
  return [];
}

/** What a doc outside every configured folder of its kind is flagged with. */
function strayNote(kind: LibraryKind, configured: readonly string[]): string {
  return kind === 'meetings' ? `not in ${configured[0] ?? 'its folder'}` : 'not mounted';
}

/** The folder a repo file sits in, as a label: the root reads as a phrase. */
const folderLabel = (relPath: string): { label: string; folder: boolean } => {
  const dir = posix.dirname(relPath);
  return dir === '.' || dir === ''
    ? { label: 'Project root', folder: false }
    : { label: dir, folder: true };
};

/** Where one doc lives, before it is keyed. */
export function placeOf(doc: PlacedDoc, ctx: PlacingContext): Omit<LibraryPlace, 'key'> {
  const configured = configuredFolders(doc.kind, ctx);
  const flag = (at: { label: string; folder: boolean }): Omit<LibraryPlace, 'key'> =>
    configured.length > 0
      ? { ...at, note: strayNote(doc.kind, configured), stray: true }
      : { ...at, stray: false };
  const storage = { label: STORED_BY_WORKSPACES, folder: false };
  const path = doc.sourceUrl;

  // 1. No file of its own, or a file in the server's data dir. A mockup is
  //    never flagged: no configured folder names its home.
  if (!path?.startsWith('/') || ctx.storageRoots.some((r) => within(path, r))) {
    return flag(storage);
  }
  const inProject = doc.repoKey !== undefined && doc.repoKey === ctx.projectRepoKey;
  // 2. A mockup's capture is what survives, so its source file is where it
  //    lives only when that file is part of the project.
  if (doc.kind === 'mockups') {
    if (inProject && ctx.projectVisible && doc.relPath !== undefined) {
      return { ...folderLabel(doc.relPath), stray: false };
    }
    return { ...storage, stray: false };
  }
  const missing = (at: Omit<LibraryPlace, 'key'>): Omit<LibraryPlace, 'key'> =>
    doc.fileMissing ? { ...at, note: 'file missing', stray: true } : at;
  // 3. In the project: the configured folder it sits in, or its own folder.
  if (inProject && doc.relPath !== undefined) {
    if (!ctx.projectVisible)
      return missing({ label: 'In the project', folder: false, stray: false });
    const rel = doc.relPath;
    // A document filed in the meetings folder is not where documents go, even
    // when a broader mount (`docs` over `docs/meetings`) holds it.
    const meetingsDoc =
      doc.kind === 'documents' &&
      ctx.meetingsFolder !== undefined &&
      inFolder(rel, ctx.meetingsFolder);
    const home = meetingsDoc
      ? undefined
      : configured.filter((f) => inFolder(rel, f)).sort((a, b) => b.length - a.length)[0];
    if (home !== undefined) {
      const at =
        home === '' ? { label: 'Project root', folder: false } : { label: home, folder: true };
      return missing({ ...at, stray: false });
    }
    return missing(flag(folderLabel(rel)));
  }
  // 4. Another repo, named when it may be; anything else is outside.
  if (doc.repoKey !== undefined) {
    const name = ctx.projectNameOf(doc.repoKey);
    return missing(flag({ label: name ? `In ${name}` : 'In another project', folder: false }));
  }
  return missing(flag({ label: 'Outside the project', folder: false }));
}

/** Structured, so a folder name holding the separator cannot alias another place. */
const placeKey = (kind: LibraryKind, p: Omit<LibraryPlace, 'key'>): string =>
  JSON.stringify([kind, p.label, p.note ?? '']);

/**
 * Every kind's locations, and the place key of each doc in input order.
 *
 * All three kinds are listed even when a board holds none of one, so the fold
 * never goes quiet about a kind. Within a kind, where things belong comes
 * before what is flagged, then by label.
 */
export function buildWhere(
  docs: readonly PlacedDoc[],
  ctx: PlacingContext,
): { where: LibraryWhere[]; keys: string[] } {
  const byKind = new Map<LibraryKind, Map<string, LibraryPlace>>(
    LIBRARY_KINDS.map((k) => [k, new Map()]),
  );
  const keys = docs.map((doc) => {
    const place = placeOf(doc, ctx);
    const key = placeKey(doc.kind, place);
    byKind.get(doc.kind)?.set(key, { key, ...place });
    return key;
  });
  const where = LIBRARY_KINDS.map((kind): LibraryWhere => {
    const places = [...(byKind.get(kind)?.values() ?? [])].sort(
      (a, b) => Number(a.stray) - Number(b.stray) || a.label.localeCompare(b.label),
    );
    const unset =
      kind !== 'mockups' && ctx.projectVisible && configuredFolders(kind, ctx).length === 0;
    return { kind, places, unset };
  });
  return { where, keys };
}

/** A doc's location input, read off its meta and its identity key. */
export function placedDoc(
  meta: { sourceUrl?: string },
  kind: LibraryKind,
  key: { repoKey: string; relPath: string } | null | undefined,
  mtime: number | undefined,
): PlacedDoc {
  return {
    kind,
    sourceUrl: meta.sourceUrl,
    repoKey: key?.repoKey,
    relPath: key?.relPath,
    fileMissing: meta.sourceUrl?.startsWith('/') === true && mtime === undefined,
  };
}

/** A doc to place, and the row that is told where it landed. */
export interface Placed {
  doc: PlacedDoc;
  row: { place?: string };
}

/** Place every doc, write each row's key, and answer the fold. */
export function placeAll(placed: readonly Placed[], ctx: PlacingContext): LibraryWhere[] {
  const { where, keys } = buildWhere(
    placed.map((p) => p.doc),
    ctx,
  );
  placed.forEach((p, i) => {
    p.row.place = keys[i];
  });
  return where;
}
