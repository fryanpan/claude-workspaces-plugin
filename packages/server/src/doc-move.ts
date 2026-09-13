/**
 * Move one board doc into a folder of the board's own project, keeping the doc.
 *
 * The migration verb. A doc held by Workspaces — no file, or a file in the
 * server's data dir — becomes a markdown file in the project, and it stays the
 * SAME document: same id, same threads, same anchors, same history. Two
 * existing paths got most of the way (copy the file and re-attach, or pin a
 * home) and both stopped one step short: the file never took the project's
 * ADDRESS, so the Library read it as outside the project, listed it a second
 * time as a file, and opening that row minted a second document over the same
 * bytes (staging readings, 2026-09-12). Claiming the address is the step this
 * module exists for.
 *
 * In order: every refusal is decided before anything is written, then the
 * file is written (exclusively), then the doc is rebound there, then the
 * address is claimed, then a meeting's filing record follows it. The old copy
 * is never touched — soft delete is project-wide, and the old file is the only
 * backup of the doc's bytes as they stood before the move.
 *
 * The caller has already refused share visitors and browsers; this module
 * trusts nothing else about its input. The target is a path RELATIVE to the
 * project root, and it must land inside a live mount or the meetings folder
 * of the board's own project after symlinks are resolved.
 */
import { lstatSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type DocMeta, attachmentIdOf } from '@claude-workspaces/core';
import { isReservedDocId } from './doc-ids.ts';
import { makeDocKey } from './doc-key.ts';
import type { DocStore } from './doc-store.ts';
import { projectRepoKey } from './library.ts';
import {
  DEFAULT_MEETING_RETENTION,
  meetingFilingFor,
  recordMeetingFiling,
} from './meeting-home.ts';
import { listMeetings } from './meetings.ts';
import { isMountableRelPath } from './mount-scan.ts';
import type { MountStore } from './mount-store.ts';
import { isWithinRoot } from './safe-path.ts';

export interface DocMoveDeps {
  docStore: Pick<DocStore, 'get' | 'list' | 'repos' | 'exportAndRebind' | 'persistMeta'>;
  mounts: Pick<MountStore, 'rootFor' | 'meetingsOf' | 'registry'>;
  dataDir: string;
  /** Is a meeting being recorded into this doc right now? */
  isRecording: (docId: string) => boolean;
}

export interface DocMoveRequest {
  workspaceId: string;
  board: { docIds: readonly string[]; leadAgentId?: string };
  docId: string;
  relPath: unknown;
}

export type DocMoveError =
  | 'bad-path'
  | 'not-found'
  | 'not-on-board'
  | 'not-markdown'
  | 'home-pinned'
  | 'recording'
  | 'no-project'
  | 'outside-project-folders'
  | 'target-exists'
  | 'address-held'
  | 'write-failed';

export type DocMoveResult =
  | { ok: true; docId: string; relPath: string; previousPath?: string; meeting: boolean }
  | { ok: false; error: DocMoveError; message: string };

/** A relative path longer than this is not one a person typed for a doc. */
const MAX_PATH_CHARS = 1024;

const refuse = (error: DocMoveError, message: string): DocMoveResult => ({
  ok: false,
  error,
  message,
});

/** Is `relPath` inside the repo-relative folder `folder` (`''` is the root)? */
const inFolder = (relPath: string, folder: string): boolean =>
  folder === '' || relPath.startsWith(`${folder}/`);

/**
 * The target as a clean repo-relative markdown path, or null.
 *
 * No absolute path, no `..`, no `.` or empty segment, no dot-directory, no
 * backslash and no NUL — `isMountableRelPath` holds the segment rules a mount
 * already enforces, so a file this verb writes is one a mount may serve.
 */
export function cleanRelPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_CHARS) return null;
  if (raw.includes('\u0000') || raw.includes('\\')) return null;
  if (!isMountableRelPath(raw)) return null;
  return raw.toLowerCase().endsWith('.md') ? raw : null;
}

/** The deepest path at or above `abs` that exists, or null. */
function deepestExisting(abs: string): string | null {
  let at = abs;
  for (;;) {
    try {
      statSync(at);
      return at;
    } catch {
      const up = dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
}

/**
 * Does the target land inside `folder` once symlinks are followed?
 *
 * The lexical check has already passed. What is left is a symlink somewhere
 * on the way: the deepest directory that exists is resolved, and it must sit
 * inside the project root — always, because the folder itself may be the
 * symlink, and resolving a link against itself proves nothing — and inside
 * the folder too once that folder exists, so a link from one folder into
 * another part of the repo is refused as well.
 */
function landsInside(root: string, folder: string, abs: string): boolean {
  const folderAbs = folder === '' ? root : join(root, folder);
  const existing = deepestExisting(dirname(abs));
  if (existing === null || !isWithinRoot(root, existing)) return false;
  const belowFolder = existing === folderAbs || existing.startsWith(`${folderAbs}/`);
  return !belowFolder || isWithinRoot(folderAbs, existing);
}

/** Move a board doc into its project. See the module header. */
export function moveDocToProject(deps: DocMoveDeps, rq: DocMoveRequest): DocMoveResult {
  const { docStore, mounts, dataDir } = deps;
  const relPath = cleanRelPath(rq.relPath);
  if (relPath === null) {
    return refuse(
      'bad-path',
      'relPath must be a path from the project root that ends in .md, with no "..", no dot-folder and no leading "/".',
    );
  }
  const doc = docStore.get(rq.docId);
  if (!doc) return refuse('not-found', 'No doc has this id.');
  const docId = doc.docId;
  if (!rq.board.docIds.includes(docId)) {
    return refuse('not-on-board', 'This doc is not filed on this board.');
  }
  const meta: DocMeta = doc.meta;
  if (meta.type !== 'markdown' || isReservedDocId(docId) || attachmentIdOf(meta) !== undefined) {
    return refuse('not-markdown', 'Only a markdown doc filed on its own can move. Mockups stay.');
  }
  if (meta.docHome !== undefined) {
    return refuse('home-pinned', 'This doc is pinned to a branch. Clear its home first.');
  }
  if (deps.isRecording(docId)) {
    return refuse('recording', 'A meeting is recording into this doc. Move it after it stops.');
  }

  const ids = new Set(rq.board.docIds);
  const repoKey = projectRepoKey(
    docStore.list().filter((m) => ids.has(m.docId)),
    (id) => docStore.repos.primaryKeyFor(id),
  );
  const root = repoKey ? mounts.rootFor(repoKey) : null;
  if (!repoKey || !root) {
    return refuse('no-project', 'This board has no project to move the doc into.');
  }
  const folders = mounts.registry.liveMounts(repoKey).map((m) => m.relPath);
  const meetings = mounts.meetingsOf(repoKey)?.relPath;
  if (meetings !== undefined) folders.push(meetings);
  const abs = join(root, relPath);
  const inside = folders.some((f) => inFolder(relPath, f) && landsInside(root, f, abs));
  if (!inside) {
    return refuse(
      'outside-project-folders',
      "The target is not inside a mounted folder or the meetings folder of this board's project.",
    );
  }
  try {
    lstatSync(abs);
    return refuse('target-exists', 'A file is already at the target. Pick another path.');
  } catch {
    // Nothing there, which is the only state a move may write into.
  }
  const docKey = makeDocKey(repoKey, relPath);
  const holder = docStore.repos.docIdFor(docKey);
  if (holder !== undefined && holder !== docId) {
    return refuse('address-held', 'Another doc already holds this path in the project.');
  }

  const moved = docStore.exportAndRebind(docId, abs);
  if (!moved.ok) {
    if (moved.error === 'target-exists') {
      return refuse('target-exists', 'A file is already at the target. Pick another path.');
    }
    return refuse('write-failed', 'The file could not be written. The doc did not move.');
  }

  // The address. A doc that already held one (a file elsewhere in a repo) is
  // RENAMED, so a link to the old path still opens this doc; a doc that held
  // none claims the new one. Without this the Library mints a second doc.
  const oldKey = docStore.repos.primaryKeyFor(docId);
  const renamed =
    oldKey !== undefined && oldKey !== docKey && docStore.repos.aliasKey(oldKey, docKey).ok;
  if (!renamed) docStore.repos.claim(docKey, docId);
  doc.meta.docKey = docKey;
  docStore.persistMeta(docId);

  const meeting = meta.huddle === true;
  const filed = meetingFilingFor(dataDir, docId);
  if (filed) {
    recordMeetingFiling(dataDir, { ...filed, repoKey, relPath });
  } else if (meeting) {
    const heard = listMeetings(dataDir, docId).at(-1)?.engine;
    recordMeetingFiling(dataDir, {
      docId,
      workspaceId: rq.workspaceId,
      filedAt: meta.createdAt,
      repoKey,
      ...(rq.board.leadAgentId !== undefined ? { leadAgentId: rq.board.leadAgentId } : {}),
      kind: meta.huddleKind === 'plan' ? 'plan' : 'discussion',
      provider: heard ?? 'none',
      relPath,
      retention: mounts.meetingsOf(repoKey)?.retention ?? DEFAULT_MEETING_RETENTION,
    });
  }
  return {
    ok: true,
    docId,
    relPath,
    ...(moved.previous !== undefined ? { previousPath: moved.previous } : {}),
    meeting: meeting || filed !== undefined,
  };
}
