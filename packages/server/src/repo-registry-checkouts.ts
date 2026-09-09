/**
 * The checkout rows of a repo record: touching one, retiring one, finding one,
 * and listing the checkouts that exist right now.
 *
 * Split out of `repo-registry.ts` when that file crossed 500 lines. It is a
 * real seam rather than a slice: everything here is a function of a repo
 * record and a path, with no knowledge of the key index, of aliases, or of
 * when the file is written. The registry keeps the half that decides WHEN to
 * persist; this half decides what a row should say.
 *
 * Nothing here deletes. Retiring stamps `removedAt` and keeps the row, which
 * is what leaves a document reviewed in a removed worktree still resolvable.
 */
import { existsSync } from 'node:fs';
import { listRepoWorktrees } from './doc-key.ts';
import { gitCommonDir } from './doc-origin-repo.ts';
import type { RegisteredCheckout, RepoRecord, RepoRegistryFile } from './repo-registry-file.ts';

/**
 * Record that a checkout was seen, adding the row if it is new.
 *
 * `registered` is the lead's vouching, so it is only ever set, never cleared
 * here — and setting it clears `removedAt`, because registering again is how
 * a lead un-retires a checkout they retired.
 */
export function touchCheckout(
  repo: RepoRecord,
  root: string,
  registered: boolean,
  now = Date.now(),
): RegisteredCheckout {
  const found = repo.checkouts.find((c) => c.root === root);
  if (found) {
    found.lastSeenAt = now;
    if (registered) {
      found.registered = true;
      found.removedAt = undefined;
    }
    return found;
  }
  const row: RegisteredCheckout = { root, addedAt: now, lastSeenAt: now, registered };
  repo.checkouts.push(row);
  return row;
}

/**
 * Retire a checkout. Soft: the row keeps its dates and its docKeys, so a doc
 * reviewed there still resolves and still opens with its comments.
 */
export function retireCheckout(
  data: RepoRegistryFile,
  root: string,
  now = Date.now(),
): { ok: boolean; repoKey?: string } {
  for (const repo of data.repos) {
    const row = repo.checkouts.find((c) => c.root === root);
    if (!row) continue;
    row.registered = false;
    row.removedAt = now;
    return { ok: true, repoKey: repo.repoKey };
  }
  return { ok: false };
}

/**
 * Is this root a checkout the registry holds a row for, and which repo is it —
 * asked WITHOUT changing anything. The retire route needs it: flushing writes
 * and moving bindings before discovering the answer is 404 is work done on
 * behalf of a caller who named a path we know nothing about.
 */
export function findCheckoutRecord(
  data: RepoRegistryFile,
  root: string,
): { repoKey: string; root: string } | null {
  for (const repo of data.repos) {
    if (repo.checkouts.some((c) => c.root === root)) return { repoKey: repo.repoKey, root };
  }
  return null;
}

/**
 * Every checkout of the repo that EXISTS right now: git's own worktree list
 * (authoritative, and needing no registration) unioned with the registered
 * rows that still exist on disk.
 *
 * The union is the point. Git knows about worktrees it created; the registry
 * knows about a separate clone the lead pointed at, which git will never
 * mention because it is a different repository object entirely.
 */
export function liveCheckouts(repo: RepoRecord | undefined): string[] {
  const out = new Set<string>();
  if (repo) {
    const common = gitCommonDir(repo.mainRoot);
    if (common) for (const wt of listRepoWorktrees(common)) out.add(wt.root);
    for (const row of repo.checkouts) {
      if (row.removedAt !== undefined) continue;
      if (existsSync(row.root)) out.add(row.root);
    }
  }
  return [...out].sort();
}
