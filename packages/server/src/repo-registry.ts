import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type DocKeyParts, docKeyForPath, listRepoWorktrees, repoIdentityAt } from './doc-key.ts';
import { findWorktreeRoot, gitCommonDir } from './doc-origin-repo.ts';

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

export const REPO_REGISTRY_FILE = 'repos.json';
const REGISTRY_VERSION = 1;

/** Alias chains are followed, so a bounded walk is the guard against a cycle
 *  written by a hand-edited file. Depth beyond this means the file is wrong. */
const MAX_ALIAS_HOPS = 8;

export interface RegisteredCheckout {
  /** Absolute path to the checkout root. */
  root: string;
  addedAt: number;
  /** Last time we saw this checkout actually exist. */
  lastSeenAt: number;
  /** Set when the lead unregistered it, or when it stopped existing. The row
   *  stays: it is how a doc bound there still names where it came from. */
  removedAt?: number;
  /** Did a person register this, or did we learn it from a bind? A registered
   *  checkout is one the lead vouched for; a learned one is a fact. */
  registered: boolean;
}

export interface RepoRecord {
  repoKey: string;
  /** Keys this repo has answered to before — a renamed remote, a moved
   *  no-remote checkout. Reads follow them; writes only ever add. */
  aliasKeys: string[];
  mainRoot: string;
  checkouts: RegisteredCheckout[];
  remoteUrl?: string;
}

export interface RepoRegistryFile {
  version: number;
  repos: RepoRecord[];
  /** `<repoKey>NUL<relPath>` → docId. */
  docKeys: Record<string, string>;
  /** An old docKey → the docKey that replaced it (a rename, or a re-key). */
  docKeyAliases: Record<string, string>;
}

function emptyFile(): RepoRegistryFile {
  return { version: REGISTRY_VERSION, repos: [], docKeys: {}, docKeyAliases: {} };
}

export type ClaimResult =
  /** The key was free and now points at this doc. */
  | { ok: true; docId: string; claimed: true }
  /** The key already resolved — to this doc, or to another one. The caller
   *  gets the doc that holds it; a claim NEVER repoints a key. */
  | { ok: true; docId: string; claimed: false };

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
    this.data = RepoRegistry.read(this.path);
  }

  /** Read the file, or start empty. A corrupt file is NOT overwritten on
   *  sight — it is kept beside the new one, because the alternative is
   *  silently discarding every doc's identity on one bad parse. */
  private static read(path: string): RepoRegistryFile {
    if (!existsSync(path)) return emptyFile();
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RepoRegistryFile>;
      return {
        version: typeof parsed.version === 'number' ? parsed.version : REGISTRY_VERSION,
        repos: Array.isArray(parsed.repos) ? parsed.repos : [],
        docKeys: parsed.docKeys && typeof parsed.docKeys === 'object' ? parsed.docKeys : {},
        docKeyAliases:
          parsed.docKeyAliases && typeof parsed.docKeyAliases === 'object'
            ? parsed.docKeyAliases
            : {},
      };
    } catch (err) {
      const kept = `${path}.corrupt-${Date.now()}`;
      try {
        renameSync(path, kept);
        console.error(`[repo-registry] ${path} did not parse; kept it at ${kept}:`, err);
      } catch {
        console.error(`[repo-registry] ${path} did not parse and could not be moved aside:`, err);
      }
      return emptyFile();
    }
  }

  /** Write temp-then-rename, so a crash mid-write leaves the old file rather
   *  than half of a new one. Mode 600: it is a map of the host's filesystem. */
  private persist(): void {
    if (this.deferred) {
      this.dirty = true;
      return;
    }
    const tmp = `${this.path}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch (err) {
      console.error(`[repo-registry] could not write ${this.path}:`, err);
    }
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
   */
  aliasKey(oldKey: string, newKey: string): void {
    if (oldKey === newKey) return;
    const from = this.resolveKey(oldKey);
    if (from === newKey) return;
    const docId = this.data.docKeys[from];
    this.data.docKeyAliases[from] = newKey;
    if (docId !== undefined && this.data.docKeys[newKey] === undefined) {
      this.data.docKeys[newKey] = docId;
    }
    this.persist();
  }

  /** Every key currently pointing at this doc, current and aliased. Used by
   *  the migration's reverse pass and by doc status surfaces. */
  keysFor(docId: string): string[] {
    const current = Object.keys(this.data.docKeys).filter((k) => this.data.docKeys[k] === docId);
    const set = new Set(current);
    for (const [from, to] of Object.entries(this.data.docKeyAliases)) {
      if (set.has(to)) set.add(from);
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
    for (const [key, held] of Object.entries(this.data.docKeys)) {
      if (held === docId) return key;
    }
    return undefined;
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

  /** The repo record for a key, creating it from a live checkout if we can. */
  private upsertRepo(parts: Pick<DocKeyParts, 'repoKey' | 'identity'>): RepoRecord {
    const existing = this.repoFor(parts.repoKey);
    if (existing) {
      // A repo whose main checkout moved keeps its record and gains the new
      // spelling; the old key stays in aliasKeys so old rows still resolve.
      if (existing.repoKey !== parts.repoKey) {
        if (!existing.aliasKeys.includes(existing.repoKey)) {
          existing.aliasKeys.push(existing.repoKey);
        }
        existing.repoKey = parts.repoKey;
      }
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
    const repo = this.upsertRepo({ repoKey: identity.repoKey, identity });
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
    const repo = this.upsertRepo({ repoKey: identity.repoKey, identity });
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
