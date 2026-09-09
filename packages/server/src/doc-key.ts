import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve as resolvePath, sep } from 'node:path';
import { shortHash } from './bind-meta.ts';
import {
  canonicalRepoRoot,
  findWorktreeRoot,
  gitCommonDir,
  listRepoWorktrees,
} from './doc-origin-repo.ts';

/**
 * A document's identity: the REPO it belongs to plus its path from the repo
 * root — not the checkout it happened to be bound from.
 *
 * The old identity was the absolute path. `deriveWorkspaceId` hashed it, so
 * the same file reached through a linked worktree derived a different set id
 * and every member doc under it forked: two docs, two comment sets, and a
 * removed worktree stranding one of them. A repo does not stop being the same
 * repo because you are standing in a different checkout of it, and neither
 * should its documents.
 *
 * What a key is NOT: an address. `newDocId` still mints random `d-` ids, and
 * the key is a lookup table that points at one. That is the same rule
 * `doc-ids.ts` already states — an id must never encode a property somebody
 * later wants to change — and here EVERY component of the key is such a
 * property. A remote can be renamed, a repo can be moved, a file can be
 * renamed. So each of those adds an ALIAS key beside the old one rather than
 * moving what the key points at.
 *
 * Everything here is pure filesystem reads of git's plumbing — no subprocess,
 * for the reason `doc-origin-repo.ts` gives: key derivation runs on the bind
 * path and beside the synchronous flush guard, where a spawn would need the
 * budget-and-SIGKILL machinery `git-provenance.ts` carries.
 */

/** The separator between a repoKey and a relPath inside a docKey. A NUL can
 *  appear in neither half, so the split is unambiguous however either is
 *  spelled — including a relPath with spaces in it. */
export const DOC_KEY_SEP = '\u0000';

export interface RepoIdentity {
  /** `git:<normalised remote>` when the repo has an `origin`, else
   *  `dir:<basename>-<hash of the main checkout's real path>`. */
  repoKey: string;
  /** The MAIN checkout's root — the repo's most durable known address, and
   *  the one that outlives any linked worktree. */
  mainRoot: string;
  /** One value for every worktree of the repo; the repo's local identity. */
  commonDir: string;
  /** The raw `origin` url, when there is one. Kept so a re-key can be
   *  explained to a person rather than just happening. */
  remoteUrl?: string;
}

/**
 * Normalise a git remote URL down to the part that identifies the repository.
 *
 * Every spelling below names one repo, and a person moves between them without
 * thinking about it — cloning over SSH on one machine and HTTPS on another is
 * the ordinary case, not the exotic one:
 *
 *     https://github.com/example/widgets.git
 *     https://user@github.com/example/widgets
 *     git@github.com:example/widgets.git
 *     ssh://git@github.com/example/widgets/
 *
 * All four normalise to `github.com/example/widgets`.
 *
 * **The HOST is lowercased; the path is not.** A host is case-insensitive by
 * the DNS rules, so a doc that changes identity when somebody types
 * `GitHub.com` is a bug. A path is not: git serves `host/Team/Widget` and
 * `host/team/widget` as two repositories on a case-sensitive server, and
 * folding them together would put two projects' documents on one key. The
 * hosts most people use happen to be case-insensitive about paths too, and
 * the cost of being wrong in that direction is only a re-key that the alias
 * table already absorbs.
 *
 * Returns null for a string that carries no host and no path — an empty
 * remote is not an identity, and keying on it would merge every repo that has
 * one.
 */
export function normalizeRemoteUrl(url: string): string | null {
  let s = url.trim();
  if (s === '') return null;
  // scp-style `git@host:path` — no scheme, and the colon is a separator
  // rather than a port. Rewrite it before anything tries to parse a scheme.
  const scp = scpStyleRemote(s);
  if (scp) s = `${scp.host}/${scp.path}`;
  else s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  // A userinfo prefix survives the scheme strip on `https://user@host/…`.
  s = s.replace(/^[^/@]+@/, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/\.git$/, '');
  s = s.replace(/\/+$/, '');
  if (s === '') return null;
  const slash = s.indexOf('/');
  const host = (slash === -1 ? s : s.slice(0, slash)).toLowerCase();
  return slash === -1 ? host : `${host}${s.slice(slash)}`;
}

/**
 * The scp shorthand for a remote, split into host and path — or null if this
 * is not one.
 *
 * `user@` is OPTIONAL, which is the whole reason this is a function. Git's
 * rule is positional: a colon with no slash before it makes the text before
 * it a host, whoever is logging in. Requiring the user meant `example.com:team/repo.git`
 * read as a filesystem path and keyed by where the clone happened to sit, so
 * two clones of one repository — one with the user spelled, one without —
 * held two identities and shared no documents.
 *
 * A single-letter host is a Windows drive (`C:/src/repo`), not a machine, and
 * a `scheme://` colon is not a separator at all.
 */
function scpStyleRemote(s: string): { host: string; path: string } | null {
  // A scheme's own colon is not a separator: `https://host/path` would
  // otherwise read as the host `https` and the path `//host/path`.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return null;
  const m = s.match(/^(?:([^/:]+)@)?([^/:]+):(.+)$/);
  const host = m?.[2];
  const path = m?.[3];
  if (!host || path === undefined || host.length < 2) return null;
  return { host, path };
}

/**
 * The `origin` url recorded in a repo's config, read straight out of the file.
 *
 * A hand-rolled INI walk rather than `git config`, for the no-subprocess
 * reason at the top of this file. It reads only what it needs: the `url` of
 * the section headed `[remote "origin"]`. Anything it cannot parse is an
 * absent remote, which is a case the caller already handles.
 */
export function readOriginUrl(commonDir: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(commonDir, 'config'), 'utf8');
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      // `[remote "origin"]`, and the subsection spelling git itself writes.
      inOrigin = /^\[\s*remote\s+"origin"\s*\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const m = line.match(/^url\s*=\s*(.+)$/);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/**
 * Is this remote spelled as a URL, or is it a path on this machine?
 *
 * Git's own rule, and the reason this function exists: a remote is remote
 * only when it carries a `scheme://` or is the scp shorthand
 * `[user@]host:path` — the user is optional, per `scpStyleRemote`. **Everything else is a filesystem path** — `../remote.git`,
 * `/srv/git/widgets.git`, `~/src/widgets`. Those are ordinary: a local
 * mirror, a bare repo on a NAS, a fixture built by a test.
 *
 * Normalising one as if it were a URL produces a CONTEXT-FREE key.
 * `../remote.git` becomes `../remote`, so two unrelated repos that each
 * happen to sit beside a sibling of that name share a repoKey, and then their
 * same-relative-path files resolve to ONE document — a stranger's file
 * opening under your comments. Detecting the local case is what stops that;
 * `localRemoteKey` below is what replaces it.
 */
function isUrlSpelledRemote(url: string): boolean {
  const s = url.trim();
  if (/^file:\/\//i.test(s)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return true;
  return scpStyleRemote(s) !== null;
}

/**
 * The repoKey for a repo whose `origin` is a path on this machine.
 *
 * The remote is resolved against the repo's own location first — which is
 * what git does with a relative remote — and then real-pathed, so two clones
 * of one local remote still land on one key while the same spelling in two
 * different parents does not. Keyed `file:` with the same
 * `<basename>-<hash>` shape as the `dir:` fallback, because it is the same
 * kind of identity: a place rather than a name, and one that changes if the
 * remote moves. The registry keeps the old key as an alias when it does.
 */
function localRemoteKey(remoteUrl: string, mainRoot: string): string {
  const spelled = remoteUrl.trim().replace(/^file:\/\//i, '');
  const expanded = spelled.startsWith('~/') ? join(homedir(), spelled.slice(2)) : spelled;
  let resolved = resolvePath(mainRoot, expanded);
  try {
    resolved = realpathSync(resolved);
  } catch {}
  resolved = resolved.replace(/\/+$/, '').replace(/\.git$/, '') || resolved;
  const base = basename(resolved).replace(/[^a-zA-Z0-9_.\-]/g, '-') || 'repo';
  return `file:${base}-${shortHash(resolved)}`;
}

/**
 * Identify the repo containing `pathInRepo` (any checkout of it, main or
 * linked; the path need not exist yet).
 *
 * The fallback when there is no `origin` is the main checkout's basename plus
 * a hash of its real path. That is a weaker identity — moving the repo changes
 * it — which is exactly why the registry keeps old keys as aliases. It is
 * still far better than the absolute path of the CHECKOUT, because every
 * worktree of the repo resolves to the same main root.
 */
export function repoIdentityAt(pathInRepo: string): RepoIdentity | null {
  const worktreeRoot = findWorktreeRoot(pathInRepo);
  if (!worktreeRoot) return null;
  const commonDir = gitCommonDir(worktreeRoot);
  if (!commonDir) return null;
  const mainRoot = canonicalRepoRoot(worktreeRoot);
  if (!mainRoot) return null;
  const remoteUrl = readOriginUrl(commonDir) ?? undefined;
  if (remoteUrl !== undefined && remoteUrl.trim() !== '') {
    if (isUrlSpelledRemote(remoteUrl)) {
      const normalised = normalizeRemoteUrl(remoteUrl);
      if (normalised) return { repoKey: `git:${normalised}`, mainRoot, commonDir, remoteUrl };
    } else {
      return { repoKey: localRemoteKey(remoteUrl, mainRoot), mainRoot, commonDir, remoteUrl };
    }
  }
  let real = mainRoot;
  try {
    real = realpathSync(mainRoot);
  } catch {}
  const base = basename(real).replace(/[^a-zA-Z0-9_.\-]/g, '-') || 'repo';
  const identity: RepoIdentity = {
    repoKey: `dir:${base}-${shortHash(real)}`,
    mainRoot,
    commonDir,
  };
  if (remoteUrl !== undefined) identity.remoteUrl = remoteUrl;
  return identity;
}

/** Join the two halves. The one place the shape is written down. */
export function makeDocKey(repoKey: string, relPath: string): string {
  return `${repoKey}${DOC_KEY_SEP}${relPath}`;
}

/** Split a docKey back into its halves, or null if it is not one. */
export function parseDocKey(key: string): { repoKey: string; relPath: string } | null {
  const i = key.indexOf(DOC_KEY_SEP);
  if (i <= 0 || i === key.length - 1) return null;
  return { repoKey: key.slice(0, i), relPath: key.slice(i + DOC_KEY_SEP.length) };
}

export interface DocKeyParts {
  repoKey: string;
  /** POSIX-style, relative to the WORKTREE root the path was found in — which
   *  is the same string in every checkout, and that is the point. */
  relPath: string;
  docKey: string;
  identity: RepoIdentity;
  /** The checkout the caller's path was actually in. */
  checkoutRoot: string;
}

/**
 * The docKey for an absolute path, or null when the path is in no repo.
 *
 * Null is not a failure: a file outside a repo keeps exactly today's
 * behaviour, a freshly minted id bound to that one path. Repo+path identity is
 * an improvement available to files that HAVE a repo, not a precondition for
 * binding.
 */
export function docKeyForPath(absPath: string): DocKeyParts | null {
  const abs = resolvePath(absPath);
  const checkoutRoot = findWorktreeRoot(abs);
  if (!checkoutRoot) return null;
  const identity = repoIdentityAt(abs);
  if (!identity) return null;
  const rel = relative(checkoutRoot, abs).split(sep).join('/');
  // A path that escapes its own worktree root has no repo-relative spelling,
  // so it has no repo identity either.
  if (rel === '' || rel.startsWith('../')) return null;
  // `.git` is git's, not the project's; a doc there is not a project document.
  if (rel === '.git' || rel.startsWith('.git/')) return null;
  return {
    repoKey: identity.repoKey,
    relPath: rel,
    docKey: makeDocKey(identity.repoKey, rel),
    identity,
    checkoutRoot,
  };
}

/**
 * Every checkout of this repo that currently exists, from git's own worktree
 * list — the same layout `git worktree list` prints.
 */
export function checkoutsOfRepo(identity: RepoIdentity): string[] {
  return listRepoWorktrees(identity.commonDir).map((w) => w.root);
}

/** Where a docKey's file would sit inside a given checkout. */
export function pathInCheckout(checkoutRoot: string, relPath: string): string {
  return join(checkoutRoot, relPath);
}

/** Does this checkout still hold a copy of the file? */
export function copyExistsIn(checkoutRoot: string, relPath: string): boolean {
  return existsSync(pathInCheckout(checkoutRoot, relPath));
}

// Re-exported so callers of the key module do not need to know that the
// worktree walk lives one file over.
export { listRepoWorktrees } from './doc-origin-repo.ts';
