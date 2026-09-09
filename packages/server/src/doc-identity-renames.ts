/**
 * Where a file went, according to git.
 *
 * Split out of `doc-identity-migration.ts` because it is the only part of the
 * migration that runs a subprocess, and the only part holding state that
 * outlives a call: one scan per repository, memoized, because a corpus of
 * thousands of documents cannot afford one `git log` per document.
 */

import { spawnSync } from 'node:child_process';
import { docKeyForPath } from './doc-key.ts';

/**
 * How far back a rename scan reads. Deep enough for a file renamed years ago
 * and shallow enough that a repository with a hundred thousand commits does
 * not stall the migration; a rename older than this leaves its document
 * unresolved, which costs the document nothing but a key claim.
 */
const RENAME_SCAN_COMMITS = 20_000;

/**
 * Every rename this checkout's history records, oldest first, memoized per
 * checkout root.
 *
 * One scan per repository rather than one per document: the corpus holds
 * thousands of rows and spawning git for each of them is the difference
 * between a migration that runs and one nobody waits for. The window is
 * bounded, and so is the wait — a corpus walk cannot afford one repository
 * to hang it.
 */
const renameScans = new Map<string, Map<string, string>>();

/** Forget the memoized scans. For a caller that renames and then asks again. */
export function clearRenameScans(): void {
  renameScans.clear();
}

function renameScanOf(checkoutRoot: string): Map<string, string> {
  const cached = renameScans.get(checkoutRoot);
  if (cached) return cached;
  const map = new Map<string, string>();
  renameScans.set(checkoutRoot, map);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  }
  let stdout = '';
  try {
    const res = spawnSync(
      'git',
      [
        'log',
        '--diff-filter=R',
        '--name-status',
        '--format=',
        '-M',
        `--max-count=${RENAME_SCAN_COMMITS}`,
      ],
      {
        cwd: checkoutRoot,
        env,
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    if (res.status !== 0 || typeof res.stdout !== 'string') return map;
    stdout = res.stdout;
  } catch {
    return map;
  }
  // Lines read `R097<TAB>old/path<TAB>new/path`, newest commit first. Read
  // them oldest first so a path renamed twice ends up mapped by its OLDEST
  // name too, and the walk below follows the chain to today's name.
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    if (!line.startsWith('R')) continue;
    const [, from, to] = line.split('\t');
    if (from && to && from !== to) map.set(from, to);
  }
  return map;
}

/**
 * Ask git where a file went.
 *
 * NOT `git log --follow -- <old path>`: a pathspec limits the diff to that
 * one path, which breaks the rename PAIR — git sees a deletion and reports
 * nothing, with `--follow` or without it. Measured on a two-commit fixture
 * while writing the test. The whole-tree scan above is what actually sees a
 * rename, and the chain walk is what survives a file renamed twice.
 */
export function gitRenameOf(absPath: string, relPath: string): string | null {
  const parts = docKeyForPath(absPath);
  if (!parts) return null;
  const renames = renameScanOf(parts.checkoutRoot);
  let current = relPath;
  const seen = new Set([current]);
  for (;;) {
    const next = renames.get(current);
    // A rename cycle is not something git records, but a corrupt or crafted
    // history could describe one, and an unguarded walk would spin forever.
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current === relPath ? null : current;
}
