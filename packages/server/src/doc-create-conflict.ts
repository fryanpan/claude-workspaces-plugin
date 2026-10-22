import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { docKeyForPath } from './doc-key.ts';

/**
 * Whether a create naming an existing doc would take that doc over (finding
 * H3 of the 16 Oct security review).
 *
 * `POST /workspaces/<ws>/docs` treats the body's `docId` as a readable name,
 * and a name that already resolves to a doc reuses it. That reuse is what an
 * agent relies on when it attaches the same file twice. It used to go
 * further: the same call with another `sourceUrl` repointed the doc, so any
 * caller that knew a doc's name could bind its comments and its live content
 * to a file of the caller's choosing, and the next write-back put the doc's
 * text into that file. A create may now re-attach the file a doc already
 * has; it may not change the doc's type or its file.
 *
 * The same file is matched three ways, because one file has several
 * spellings: the path as given, its real path (a symlinked checkout), and
 * its repo key (the same file in a second checkout of the repo, which
 * `resolveLiveCopy` already treats as one doc).
 */
export type CreateConflict = 'type' | 'source';

export function createConflictWith(
  existing: { type?: string; sourceUrl?: string },
  requested: { type: string; sourceUrl?: string },
): CreateConflict | null {
  if (existing.type !== undefined && existing.type !== requested.type) return 'type';
  // A re-post that names no file leaves the binding alone, which is not a
  // takeover; `getOrCreate` keeps the existing source in that case.
  if (requested.sourceUrl === undefined) return null;
  // A doc that has no file yet is bound to one by its own name only once:
  // giving it a file is a repoint like any other.
  if (existing.sourceUrl === undefined) return 'source';
  return sameFile(existing.sourceUrl, requested.sourceUrl) ? null : 'source';
}

function sameFile(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  const realA = realOrNull(a);
  if (realA !== null && realA === realOrNull(b)) return true;
  const keyA = docKeyForPath(a);
  const keyB = keyA ? docKeyForPath(b) : null;
  return keyA !== null && keyB !== null && keyA.docKey === keyB.docKey;
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
