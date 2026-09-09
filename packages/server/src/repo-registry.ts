import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DOC_KEY_SEP,
  type DocKeyParts,
  docKeyForPath,
  listRepoWorktrees,
  makeDocKey,
  parseDocKey,
  repoIdentityAt,
} from './doc-key.ts';
import { findWorktreeRoot, gitCommonDir } from './doc-origin-repo.ts';
import {
  REPO_REGISTRY_FILE,
  type RegisteredCheckout,
  type RepoRecord,
  type RepoRegistryFile,
  readRegistryFile,
  writeRegistryFile,
} from './repo-registry-file.ts';

/** Alias chains are followed, so a bounded walk is the guard against a cycle
 *  written by a hand-edited file. Depth beyond this means the file is wrong. */
const MAX_ALIAS_HOPS = 8;

export {
  REPO_REGISTRY_FILE,
  type RegisteredCheckout,
  type RepoRecord,
  type RepoRegistryFile,
} from './repo-registry-file.ts';

/**
 * Which docId a repo+path key resolves to, and which checkouts of a repo the
 * lead has registered.
 *
 * Two jobs, one file, because they are two halves of one question. The key
 * index is what makes a bind from a second checkout attach to the doc that
 * already exists; the checkout list is what keeps that answer available after
 * `git worktree remove`. Git can enumerate a repo's worktrees on its own — so
 * registration is NOT what makes resolution work. It is what makes resolution
 * SURVIVE, because a removed worktree is gone from git's list while the
 * documents that were reviewed in it are not.
 *
 * Everything in here names host paths, so it lives beside the `.ydoc` corpus
 * in the data dir, never in a CRDT a share visitor syncs — the same rule
 * `private-meta.ts` states for `sourceUrl`.
 *
 * Nothing here ever deletes. A key that stops being derivable becomes an
 * alias for the one that replaced it; an unregistered checkout keeps its row
 * with a `removedAt`. That is the project-wide soft-delete rule, and it is
 * also what makes the migration reversible.
 */

export type ClaimResult =
  /** The key was free and now points at this doc. */
  | { ok: true; docId: string; claimed: true }
  /** The key already resolved — to this doc, or to another one. The caller
   *  gets the doc that holds it; a claim NEVER repoints a key. */
  | { ok: true; docId: string; claimed: false };

/**
 * What `aliasKey` did. `aliased: false` means there was nothing to record —
 * the two keys were already the same key.
 */
export type AliasResult =
  | { ok: true; aliased: boolean }
  | {
      ok: false;
      error: 'held-by-other';
      /** The doc that already holds the NEW key, and keeps it. */
      docId: string;
      /** The doc that holds the old key, and keeps that. */
      otherDocId: string;
    };

export type RegisterResult =
  | { ok: true; repoKey: string; mainRoot: string; checkouts: string[]; alreadyKnown: boolean }
  | { ok: false; error: 'not-a-repo' };

/**
 * The registry, held in memory and mirrored to one JSON file.
 *
 * Reads are hot — every bind and every flush asks it something — so the file
 * is loaded once and written back on change. It is small by construction: one
 * row per repo, one entry per bound file.
 */
export class RepoRegistry {
  private readonly path: string;
  private data: RepoRegistryFile;
  /** Suppresses the write while a batch (the migration) is mid-flight. */
  private deferred = false;
  private dirty = false;

  constructor(dataDir: string) {
    this.path = join(dataDir, REPO_REGISTRY_FILE);
    this.data = readRegistryFile(this.path);
  }

  /** Persist unless a batch is holding writes. */
  private persist(): void {
    if (this.deferred) {
      this.dirty = true;
      return;
    }
    if (writeRegistryFile(this.path, this.data)) this.dirty = false;
  }

  /** Hold writes until `endBatch`. One fsync for a migration over thousands
   *  of docs rather than thousands of them. */
  beginBatch(): void {
    this.deferred = true;
  }

  endBatch(): void {
    this.deferred = false;
    if (this.dirty) this.persist();
  }

  /**
   * Throw away everything a batch changed and go back to a snapshot.
   *
   * The rollback half of `beginBatch`. Deferred writes have touched memory
   * and not the file, so restoring memory and NOT persisting is a true undo —
   * which is what makes "file the claims, then merge, and keep neither if the
   * merge is refused" possible. Ends the batch: a rolled-back run is over.
   */
  restore(snapshot: RepoRegistryFile): void {
    this.data = JSON.parse(JSON.stringify(snapshot)) as RepoRegistryFile;
    this.dirty = false;
    this.deferred = false;
  }

  /** The whole file, for the migration and for tests. Cloned, so a caller
   *  cannot mutate the registry by holding its innards. */
  snapshot(): RepoRegistryFile {
    return JSON.parse(JSON.stringify(this.data)) as RepoRegistryFile;
  }

  /**
   * Follow the alias chain to the key that is current. A key with no alias is
   * already current, which is the common case and costs one map lookup.
   */
  resolveKey(docKey: string): string {
    let key = docKey;
    for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
      const next = this.data.docKeyAliases[key];
      if (next === undefined || next === key) return key;
      key = next;
    }
    console.error(`[repo-registry] alias chain from "${docKey}" is too deep; stopping`);
    return key;
  }

  /** The docId this key resolves to, following aliases. */
  docIdFor(docKey: string): string | undefined {
    return this.data.docKeys[this.resolveKey(docKey)];
  }

  /** The docId for a path, when the path is in a repo and the key is held. */
  docIdForPath(absPath: string): string | undefined {
    const parts = docKeyForPath(absPath);
    return parts ? this.docIdFor(parts.docKey) : undefined;
  }

  /**
   * Point a key at a doc, unless it already points somewhere.
   *
   * First writer wins, and there is no repoint — the same refusal
   * `DocStore.claimAlias` makes, for the same reason. A key that could be
   * repointed would make every captured review URL provisional: the link in
   * yesterday's comment would resolve, silently, to a document nobody meant
   * to send. The loser is returned rather than swallowed, so the caller binds
   * to the doc that holds the key instead of minting a second one.
   */
  claim(docKey: string, docId: string): ClaimResult {
    const key = this.resolveKey(docKey);
    const held = this.data.docKeys[key];
    if (held !== undefined) return { ok: true, docId: held, claimed: held === docId };
    this.data.docKeys[key] = docId;
    this.persist();
    return { ok: true, docId, claimed: true };
  }

  /**
   * Record that `oldKey` is now spelled `newKey` — a file rename, or a repo
   * that changed its remote.
   *
   * The docId does not move. If the new key is free it inherits the old key's
   * doc, and the old key stays resolving through the alias, so a link written
   * before the rename still opens the same document with the same comments.
   *
   * **It refuses when the two keys belong to different documents.** Writing
   * the alias anyway would repoint every link saved against the old key at
   * somebody else's document — the silent repoint `claim` exists to refuse,
   * arriving through the back door. Two documents each holding one of the
   * keys is a real state (one bound before a rename, one after), and the
   * answer to it is a merge somebody decides on, not a table write nobody
   * sees. Both docs are named in the result so the caller can report it.
   */
  aliasKey(oldKey: string, newKey: string): AliasResult {
    if (oldKey === newKey) return { ok: true, aliased: false };
    const from = this.resolveKey(oldKey);
    if (from === newKey) return { ok: true, aliased: false };
    // A key that already resolves BACK to this one would close a cycle, and a
    // cycle makes `resolveKey` answer whichever end it was asked from. It
    // happens for real: a repo that changes its remote and changes it back.
    // The keys already resolve to one document, so there is nothing to add.
    if (this.resolveKey(newKey) === from) return { ok: true, aliased: false };
    const docId = this.data.docKeys[from];
    const heldByNew = this.data.docKeys[newKey];
    if (docId !== undefined && heldByNew !== undefined && heldByNew !== docId) {
      return { ok: false, error: 'held-by-other', docId: heldByNew, otherDocId: docId };
    }
    this.data.docKeyAliases[from] = newKey;
    if (docId !== undefined && heldByNew === undefined) {
      this.data.docKeys[newKey] = docId;
    }
    this.persist();
    return { ok: true, aliased: true };
  }

  /** Every key currently pointing at this doc, current and aliased. Used by
   *  the migration's reverse pass and by doc status surfaces. */
  keysFor(docId: string): string[] {
    const current = Object.keys(this.data.docKeys).filter((k) => this.data.docKeys[k] === docId);
    const set = new Set(current);
    // Follow each alias to the END of its chain, not one hop. A file renamed
    // twice, or renamed inside a repo that later changed its remote, leaves a
    // two-hop chain — and the one-hop version silently dropped the oldest
    // spelling, which is exactly the link most likely to be in somebody's
    // saved URL.
    for (const from of Object.keys(this.data.docKeyAliases)) {
      if (set.has(this.resolveKey(from))) set.add(from);
    }
    return [...set].sort();
  }

  /**
   * The key a doc holds, if it holds one — the canonical one, never an alias.
   *
   * `meta.docKey` is written when a doc is minted, so a doc that predates
   * this feature has none; the registry does, because the migration claims
   * keys there and nowhere else. Reading through this is what lets a
   * migrated doc resolve its copies without the migration having to rewrite
   * six thousand documents to say what one table already knows.
   */
  primaryKeyFor(docId: string): string | undefined {
    let aliased: string | undefined;
    for (const [key, held] of Object.entries(this.data.docKeys)) {
      if (held !== docId) continue;
      // A doc holds both spellings after a re-key. The CURRENT one is the key
      // that is not itself aliased away; the old one is kept only as a
      // fallback, so this never answers `undefined` for a doc that holds a
      // key nobody has re-keyed forward yet.
      if (this.resolveKey(key) === key) return key;
      aliased ??= key;
    }
    return aliased;
  }

  /** Drop a key claim — the migration's `--revert`, and nothing else. Never
   *  called on a live path: a doc losing its key silently would mint a second
   *  doc on the next bind. */
  releaseKey(docKey: string): void {
    if (this.data.docKeys[docKey] === undefined && this.data.docKeyAliases[docKey] === undefined) {
      return;
    }
    delete this.data.docKeys[docKey];
    delete this.data.docKeyAliases[docKey];
    this.persist();
  }

  private repoFor(repoKey: string): RepoRecord | undefined {
    return this.data.repos.find((r) => r.repoKey === repoKey || r.aliasKeys.includes(repoKey));
  }

  /**
   * The record for a repo we are standing IN, found by where it is rather
   * than by what it is called.
   *
   * Every component of a repoKey is mutable — that is the premise the whole
   * feature is built on — so a lookup by key alone misses the case it exists
   * for. Change a repo's `origin` and the derived key is new, the key lookup
   * finds nothing, a SECOND record appears, and the next bind of a file that
   * already has a document mints another one: exactly the duplicate this
   * feature removes, reintroduced by a `git remote set-url`.
   *
   * The place is what stayed the same, so the place is what is matched: the
   * main checkout, or any checkout row the registry already holds.
   */
  private repoAtRoot(mainRoot: string, checkoutRoot?: string): RepoRecord | undefined {
    return this.data.repos.find(
      (r) =>
        r.mainRoot === mainRoot ||
        r.checkouts.some(
          (c) => c.root === mainRoot || (checkoutRoot !== undefined && c.root === checkoutRoot),
        ),
    );
  }

  /**
   * Give an existing record a new canonical key, keeping the old one working.
   *
   * Two writes, and the second is the one that matters. The record gains the
   * new spelling and keeps the old in `aliasKeys`, so a row that still names
   * the old repoKey resolves. And every docKey filed under the old repoKey is
   * aliased forward to its spelling under the new one — without that, the
   * record would be findable while every document in it was not, and the next
   * bind would mint a duplicate under the new key.
   */
  private adoptRepoKey(existing: RepoRecord, newKey: string): void {
    const oldKey = existing.repoKey;
    if (oldKey === newKey) return;
    if (!existing.aliasKeys.includes(oldKey)) existing.aliasKeys.push(oldKey);
    // The record must not alias its own current key: this repo has been keyed
    // this way before, and the alias list is what it USED to be called.
    existing.aliasKeys = existing.aliasKeys.filter((k) => k !== newKey);
    existing.repoKey = newKey;
    const prefix = `${oldKey}${DOC_KEY_SEP}`;
    for (const docKey of Object.keys(this.data.docKeys)) {
      if (!docKey.startsWith(prefix)) continue;
      const parsed = parseDocKey(docKey);
      if (!parsed) continue;
      const res = this.aliasKey(docKey, makeDocKey(newKey, parsed.relPath));
      if (!res.ok) {
        // Two documents, one on each spelling of the key. Refusing is the
        // same rule `aliasKey` states: a merge is somebody's decision, not a
        // table write nobody sees.
        console.error(
          `[repo-registry] ${docKey} could not follow the re-key: ${res.docId} already holds the new spelling`,
        );
      }
    }
  }

  /** The repo record for a key, creating it from a live checkout if we can. */
  private upsertRepo(
    parts: Pick<DocKeyParts, 'repoKey' | 'identity'>,
    checkoutRoot?: string,
  ): RepoRecord {
    const existing =
      this.repoFor(parts.repoKey) ?? this.repoAtRoot(parts.identity.mainRoot, checkoutRoot);
    if (existing) {
      // A repo that re-keyed — a renamed remote, a moved no-remote checkout —
      // keeps its record, its checkouts and its documents; what changes is
      // the spelling, and every old spelling keeps resolving.
      this.adoptRepoKey(existing, parts.repoKey);
      existing.mainRoot = parts.identity.mainRoot;
      if (parts.identity.remoteUrl !== undefined) existing.remoteUrl = parts.identity.remoteUrl;
      return existing;
    }
    const record: RepoRecord = {
      repoKey: parts.repoKey,
      aliasKeys: [],
      mainRoot: parts.identity.mainRoot,
      checkouts: [],
    };
    if (parts.identity.remoteUrl !== undefined) record.remoteUrl = parts.identity.remoteUrl;
    this.data.repos.push(record);
    return record;
  }

  /**
   * Note that we have seen a checkout, without a person asking for it.
   *
   * A bind teaches the registry where the file was; that is a fact worth
   * keeping, and it is what lets an ambiguity report name a checkout nobody
   * registered. It does NOT set `registered` — vouching for a checkout is the
   * lead's act, not a side effect of a bind.
   */
  noteCheckout(absPathInRepo: string): void {
    const identity = repoIdentityAt(absPathInRepo);
    const checkoutRoot = findWorktreeRoot(absPathInRepo);
    if (!identity || !checkoutRoot) return;
    const repo = this.upsertRepo({ repoKey: identity.repoKey, identity }, checkoutRoot);
    this.touchCheckout(repo, checkoutRoot, false);
    this.persist();
  }

  private touchCheckout(repo: RepoRecord, root: string, registered: boolean): RegisteredCheckout {
    const now = Date.now();
    const found = repo.checkouts.find((c) => c.root === root);
    if (found) {
      found.lastSeenAt = now;
      // Registering again is how a lead un-removes a checkout they retired.
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
   * Register a checkout — the lead's verb.
   *
   * Registering the MAIN checkout of a repo is meaningful too: it is how a
   * project says "this repo's documents are mine", and it seeds the record
   * that every later worktree of the repo attaches to.
   */
  registerCheckout(path: string): RegisterResult {
    const identity = repoIdentityAt(path);
    if (!identity) return { ok: false, error: 'not-a-repo' };
    const checkoutRoot = findWorktreeRoot(path) ?? identity.mainRoot;
    const repo = this.upsertRepo({ repoKey: identity.repoKey, identity }, checkoutRoot);
    const before = repo.checkouts.find((c) => c.root === checkoutRoot);
    const alreadyKnown = before?.registered === true && before.removedAt === undefined;
    this.touchCheckout(repo, checkoutRoot, true);
    this.persist();
    return {
      ok: true,
      repoKey: repo.repoKey,
      mainRoot: repo.mainRoot,
      checkouts: this.checkoutsFor(repo.repoKey),
      alreadyKnown,
    };
  }

  /**
   * Retire a checkout. Soft: the row keeps its dates and its docKeys, so a
   * doc reviewed there still resolves and still opens with its comments. The
   * caller is expected to have flushed first — a removal we can SEE is a
   * removal we can flush before, which is the whole reason this verb exists
   * rather than leaving people to `git worktree remove` unannounced.
   */
  unregisterCheckout(path: string): { ok: boolean; repoKey?: string } {
    const root = findWorktreeRoot(path) ?? path;
    for (const repo of this.data.repos) {
      const row = repo.checkouts.find((c) => c.root === root);
      if (!row) continue;
      row.registered = false;
      row.removedAt = Date.now();
      this.persist();
      return { ok: true, repoKey: repo.repoKey };
    }
    return { ok: false };
  }

  /** Rows the registry holds for a repo, whatever their state. */
  checkoutRows(repoKey: string): RegisteredCheckout[] {
    return this.repoFor(repoKey)?.checkouts ?? [];
  }

  /**
   * Every checkout of the repo that EXISTS right now: git's own worktree list
   * (which is authoritative and needs no registration) unioned with the
   * registered rows that still exist on disk.
   *
   * The union is the point. Git knows about worktrees it created; the
   * registry knows about a separate clone the lead pointed at, which git will
   * never mention because it is a different repository object entirely.
   */
  checkoutsFor(repoKey: string): string[] {
    const repo = this.repoFor(repoKey);
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

  /** Every repo the registry knows, newest checkout first inside each. */
  listRepos(): RepoRecord[] {
    return this.snapshot().repos;
  }
}
