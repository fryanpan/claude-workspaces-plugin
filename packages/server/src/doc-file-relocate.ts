/**
 * Move a bound doc's file, or point the doc at a file git already moved.
 *
 * The doc stays the same document: same id, threads, anchors, backlinks and
 * front matter. Only the file it reads and writes changes, and its repo+path
 * address follows (the old address is kept as an alias, so a link to the old
 * path still opens this doc).
 *
 * Two modes:
 * - `move`: the server renames the file. It refuses a target that exists and
 *   never copies-then-deletes.
 * - `repoint`: the file is already at the new path (after `git mv`); the doc
 *   follows it. Nothing is renamed.
 *
 * Unflushed edits are never lost. `move` flushes the doc to the old file
 * before the rename. Both modes then rebind with the old binding's
 * bookkeeping (`FileBindings.followMovedFile`): live edits that the file does
 * not hold are written to the new path, and an outside edit made while the
 * doc was idle is read in.
 *
 * Every refusal is decided before anything is written. The caller has
 * already refused share visitors and browsers.
 */
import { lstatSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { attachmentIdOf } from '@claude-workspaces/core';
import { docKeyForPath } from './doc-key.ts';
import { placementEscapesRoot } from './doc-origin-repo.ts';
import type { DocStore } from './doc-store.ts';
import { statStampSync } from './file-stamp.ts';
import { boundFiles } from './slow-fs.ts';

export type RelocateMode = 'move' | 'repoint';

export type RelocateError =
  | 'bad-mode'
  | 'bad-path'
  | 'not-found'
  | 'not-markdown'
  | 'set-member'
  | 'home-pinned'
  | 'not-bound'
  | 'no-root'
  | 'same-path'
  | 'outside-root'
  | 'out-of-lead-scope'
  | 'contained-move'
  | 'target-exists'
  | 'target-missing'
  | 'source-missing'
  | 'path-held'
  | 'busy'
  | 'unreadable'
  | 'move-failed';

export type RelocateResult =
  | {
      ok: true;
      docId: string;
      mode: RelocateMode;
      path: string;
      previousPath: string;
      relPath: string;
    }
  | { ok: false; error: RelocateError; message: string };

export interface RelocateDeps {
  docStore: Pick<DocStore, 'get' | 'boundPathOf' | 'repos' | 'persistMeta' | 'fileMoves'>;
  /** Wait between checks for a write-back already on the pool. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RelocateRequest {
  docId: string;
  path: unknown;
  mode: unknown;
  /** Set for a walled lead: may this lead write `path`? */
  leadWritable?: (path: string) => boolean;
}

/** Longer than this is not a path a person chose for a doc. */
const MAX_PATH_CHARS = 4096;
/** How long to wait for a write-back already on the pool to land. */
const IN_FLIGHT_WAIT_MS = 5000;
const IN_FLIGHT_POLL_MS = 10;
/** Edits arriving between the read and the rename restart the attempt. */
const MAX_ATTEMPTS = 5;
const PROSE_EXT = /\.(md|mdx|markdown)$/i;

const refuse = (error: RelocateError, message: string): RelocateResult => ({
  ok: false,
  error,
  message,
});

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function exists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/** The new path, absolute, or null when it cannot be a doc's file. */
function resolveTarget(raw: unknown, root: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_CHARS) return null;
  if (raw.includes('\u0000') || raw.includes('\\')) return null;
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  return PROSE_EXT.test(abs) ? abs : null;
}

/** The repo-relative spelling, or null when `abs` is not inside `root`. */
function relInside(root: string, abs: string): string | null {
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  const segments = rel.split(sep);
  if (segments.includes('.git')) return null;
  return segments.join('/');
}

/** Move or repoint a bound doc's file. See the module header. */
export async function relocateDocFile(
  deps: RelocateDeps,
  rq: RelocateRequest,
): Promise<RelocateResult> {
  const { docStore } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  if (rq.mode !== 'move' && rq.mode !== 'repoint') {
    return refuse('bad-mode', 'mode must be "move" (the server renames the file) or "repoint".');
  }
  const mode: RelocateMode = rq.mode;
  const doc = docStore.get(rq.docId);
  if (!doc) return refuse('not-found', 'No doc has this id.');
  const docId = doc.docId;
  if (doc.meta.type !== 'markdown') {
    return refuse('not-markdown', 'Only a markdown doc bound to a file can move.');
  }
  if (attachmentIdOf(doc.meta) !== undefined) {
    return refuse(
      'set-member',
      'This doc belongs to a diff review or folder browse. Use refresh_attachment_set after the file moves.',
    );
  }
  if (doc.meta.docHome !== undefined) {
    return refuse('home-pinned', 'This doc is pinned to a branch. Clear its home first.');
  }
  const old = docStore.boundPathOf(docId);
  if (!old) return refuse('not-bound', 'This doc is not bound to a file.');

  // The root the file must stay inside: a walled lead's registered root, or
  // the git checkout that holds the file.
  const guards = boundFiles.guards;
  const contained = guards.containedOf(old);
  const oldKey = contained ? null : docKeyForPath(old);
  const root = contained ? contained.root : oldKey?.checkoutRoot;
  if (!root) {
    return refuse(
      'no-root',
      'This doc’s file is not in a git repository, so it has no root to move inside.',
    );
  }
  const target = resolveTarget(rq.path, root);
  if (target === null) {
    return refuse(
      'bad-path',
      'path must be a .md, .mdx or .markdown file: absolute, or relative to the repository root.',
    );
  }
  if (target === old) return refuse('same-path', 'The doc is already bound to this path.');
  const relPath = relInside(root, target);
  if (relPath === null || placementEscapesRoot(root, relPath)) {
    return refuse(
      'outside-root',
      'The new path must stay inside the same repository as the old one.',
    );
  }
  const newKey = contained ? null : docKeyForPath(target);
  if (contained) {
    if (guards.containedOf(target)?.root !== root || !guards.allows(target)) {
      return refuse('outside-root', 'The new path must stay inside the same registered folder.');
    }
  } else if (guards.covers(target) || newKey?.checkoutRoot !== root) {
    return refuse(
      'outside-root',
      'The new path must stay inside the same repository as the old one.',
    );
  }
  if (rq.leadWritable && !(rq.leadWritable(old) && rq.leadWritable(target))) {
    return refuse(
      'out-of-lead-scope',
      'Both the doc’s file and the new path must be inside the folders registered for this board.',
    );
  }
  if (mode === 'move' && contained) {
    return refuse(
      'contained-move',
      'The server does not rename files inside a walled folder. Move it with git mv, then call this with mode "repoint".',
    );
  }
  if (docStore.fileMoves.boundAt(target).some((id) => id !== docId)) {
    return refuse('path-held', 'Another doc is already bound to this path.');
  }
  const holder = newKey ? docStore.repos.docIdFor(newKey.docKey) : undefined;
  if (holder !== undefined && holder !== docId) {
    return refuse('path-held', 'Another doc already holds this path in the repository.');
  }
  if (mode === 'move' && exists(target)) {
    return refuse('target-exists', 'A file is already at the new path. Nothing was moved.');
  }

  const readFrom = mode === 'move' ? old : target;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // A pool write landing after the flush below would put older bytes back
    // on the old path, so wait for it first.
    for (let waited = 0; docStore.fileMoves.inFlight(docId); waited += IN_FLIGHT_POLL_MS) {
      if (waited >= IN_FLIGHT_WAIT_MS) {
        return refuse('busy', 'A save of this doc did not finish. Try again.');
      }
      await sleep(IN_FLIGHT_POLL_MS);
    }
    // Move: the old file takes the live content before it is renamed. A
    // repoint must not flush, because the old path may be gone and a flush
    // would put the file back there.
    if (mode === 'move') docStore.fileMoves.flushNow(docId);
    const read = await boundFiles.read(readFrom, { keep: false });
    if (read.status !== 'ok') {
      return refuse('unreadable', 'The file could not be read. Nothing was moved.');
    }
    if (!read.exists) {
      return mode === 'move'
        ? refuse(
            'source-missing',
            'The bound file is not on disk. If git moved it, use mode "repoint".',
          )
        : refuse(
            'target-missing',
            'No file is at the new path. Move it first, or use mode "move".',
          );
    }
    // Anything that changed during the read starts the attempt over.
    if (docStore.fileMoves.inFlight(docId)) continue;
    if (mode === 'move' && docStore.fileMoves.pendingWrite(docId)) continue;
    if (mode === 'move') {
      try {
        const st = statStampSync(old);
        if (st.mtimeMs !== read.mtimeMs || st.size !== read.size) continue;
      } catch {
        continue;
      }
      if (exists(target)) {
        return refuse('target-exists', 'A file is already at the new path. Nothing was moved.');
      }
      try {
        mkdirSync(dirname(target), { recursive: true });
        renameSync(old, target);
      } catch (err) {
        console.error(`[doc-relocate] ${docId}: rename failed:`, err);
        return refuse('move-failed', 'The file could not be renamed. The doc did not move.');
      }
    }
    docStore.fileMoves.follow(doc, target, {
      exists: true,
      text: read.text,
      mtimeMs: read.mtimeMs,
      size: read.size,
    });
    claimAddress(deps, docId, newKey?.docKey);
    // Open pages re-read the doc's path off this (`doc-ready.ts`): the path
    // itself never enters the CRDT, which share visitors sync.
    doc.ydoc.transact(() => doc.ydoc.getMap('meta').set('fileMovedAt', Date.now()));
    return { ok: true, docId, mode, path: target, previousPath: old, relPath };
  }
  return refuse('busy', 'The doc kept changing while it was being moved. Try again.');
}

/** The new repo+path address, with the old one kept as an alias. */
function claimAddress(deps: RelocateDeps, docId: string, newKey: string | undefined): void {
  const { docStore } = deps;
  const doc = docStore.get(docId);
  if (!doc || newKey === undefined) return;
  const prior = docStore.repos.primaryKeyFor(docId);
  const aliased =
    prior !== undefined && prior !== newKey && docStore.repos.aliasKey(prior, newKey).ok;
  if (!aliased) docStore.repos.claim(newKey, docId);
  doc.meta.docKey = newKey;
  docStore.persistMeta(docId);
}
