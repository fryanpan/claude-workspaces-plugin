import { execFile, spawnSync } from 'node:child_process';
import type { DiffFileStatus } from '@claude-workspaces/core';
import { hardenedGitArgs } from './git-hardening.ts';

/**
 * Git plumbing for diff reviews. Every call shells out with an argv array
 * (never a shell string) and passes `--` separators, so repo paths and refs
 * can't smuggle options. Refs beginning with `-` are rejected outright.
 *
 * The reads are written ONCE, as generators that yield each git argv and are
 * handed back its result, and run two ways: `runSync` with `spawnSync`, and
 * `runAsync` with `execFile`. The async driver exists for the stall tick: it
 * reads every dispatched builder's worktree, about a dozen git processes
 * each, and with `spawnSync` four dispatches held the loop for 1.9s in a
 * local reproduction while the process itself used 40ms of CPU — the rest
 * was waiting on git. One body of logic, so the two drivers cannot answer
 * differently.
 */

const MAX_GIT_BUFFER = 64 * 1024 * 1024;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** A git read: yields each argv (without `-C <repo>`), receives its result. */
type GitSteps<T> = Generator<string[], T, GitResult>;

function gitSync(repo: string, args: string[]): GitResult {
  const res = spawnSync('git', hardenedGitArgs(['-C', repo, ...args]), {
    encoding: 'utf8',
    maxBuffer: MAX_GIT_BUFFER,
  });
  return {
    ok: res.status === 0,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
  };
}

/**
 * How long one awaited git process may run. A sync read that hangs wedges the
 * whole server, which is loud; an async one that hangs would leave its caller
 * pending forever, and the stall tick skips every tick while its last
 * `prepare` is still pending. Killed, the read answers "cannot tell".
 */
const GIT_ASYNC_TIMEOUT_MS = 30_000;

function gitAsync(repo: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      hardenedGitArgs(['-C', repo, ...args]),
      {
        encoding: 'utf8',
        maxBuffer: MAX_GIT_BUFFER,
        timeout: GIT_ASYNC_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
      (err, stdout, stderr) => {
        resolve({
          ok: err === null,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      },
    );
  });
}

function runSync<T>(repo: string, steps: GitSteps<T>): T {
  let next = steps.next();
  while (!next.done) next = steps.next(gitSync(repo, next.value));
  return next.value;
}

async function runAsync<T>(repo: string, steps: GitSteps<T>): Promise<T> {
  let next = steps.next();
  while (!next.done) next = steps.next(await gitAsync(repo, next.value));
  return next.value;
}

/** A ref we're willing to hand to git: no leading '-', no whitespace/NUL. */
export function isSafeRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 256 && !ref.startsWith('-') && !/[\s\0]/.test(ref);
}

/**
 * A full object id as git prints one — 40 hex under SHA-1, 64 under the
 * SHA-256 object format. Accepting only the first length makes every read
 * here answer "cannot tell" in a repository that is perfectly readable.
 */
export function isObjectId(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s) || /^[0-9a-f]{64}$/.test(s);
}

/** Resolve a ref to a full commit hash, or null if it doesn't name a commit. */
export function resolveCommit(repo: string, ref: string): string | null {
  return runSync(repo, resolveCommitSteps(ref));
}

function* resolveCommitSteps(ref: string): GitSteps<string | null> {
  if (!isSafeRef(ref)) return null;
  const res = yield ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`];
  const hash = res.stdout.trim();
  return res.ok && isObjectId(hash) ? hash : null;
}

export interface DiffFileEntry {
  /** Path at the target commit (or at base, for deletions). */
  relPath: string;
  status: DiffFileStatus;
  /** Path at the base commit when renamed (differs from relPath). */
  oldPath?: string;
  /** Line counts from --numstat; undefined for binary files. */
  additions?: number;
  deletions?: number;
  binary: boolean;
  /**
   * True when the file's every changed line differs only in whitespace —
   * a formatter run, a reindent, trailing-space cleanup. Derived by asking
   * git the same question twice, once with `-w`: a file the plain pass
   * reports and the `-w` pass drops has nothing to read.
   *
   * The file is NOT withheld from the review; the sidebar ranks it last.
   */
  whitespaceOnly?: boolean;
}

/** Parsed `--numstat -z` record, keyed by the file's path at the target. */
type NumstatEntry = { additions?: number; deletions?: number; binary: boolean };

/**
 * Parse `git diff --numstat -z` output.
 *
 * The -z form is "add\tdel\tpath\0" normally, but for renames and copies the
 * path field is EMPTY and followed by two extra NUL-terminated fields:
 * "add\tdel\t\0old\0new\0".
 */
function parseNumstat(stdout: string): Map<string, NumstatEntry> {
  const counts = new Map<string, NumstatEntry>();
  const t = stdout.split('\0');
  for (let i = 0; i < t.length; ) {
    const rec = t[i];
    if (!rec) break;
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) break;
    const binary = m[1] === '-';
    const entry: NumstatEntry = {
      additions: binary ? undefined : Number(m[1]),
      deletions: binary ? undefined : Number(m[2]),
      binary,
    };
    if (m[3] === '') {
      const newPath = t[i + 2];
      i += 3;
      if (newPath) counts.set(newPath, entry);
    } else {
      counts.set(m[3] as string, entry);
      i += 1;
    }
  }
  return counts;
}

/**
 * List the files changed between a base commit and either a target commit
 * or — when `target` is null — the WORKING TREE (the folder as it is now,
 * uncommitted edits included; untracked files are appended as additions).
 * Rename detection on, per-file line counts joined in. Copies (C) are
 * treated as additions.
 */
export function diffFiles(repo: string, base: string, target: string | null): DiffFilesResult {
  return runSync(repo, diffFilesSteps(base, target));
}

/** `diffFiles` without holding the loop: the same reads, each git process awaited. */
export function diffFilesAsync(
  repo: string,
  base: string,
  target: string | null,
): Promise<DiffFilesResult> {
  return runAsync(repo, diffFilesSteps(base, target));
}

type DiffFilesResult = { ok: true; files: DiffFileEntry[] } | { ok: false; error: string };

function* diffFilesSteps(base: string, target: string | null): GitSteps<DiffFilesResult> {
  const range = target ? [base, target] : [base];
  const ns = yield [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--name-status',
    '-z',
    '-M',
    ...range,
    '--',
  ];
  if (!ns.ok) return { ok: false, error: ns.stderr.trim() || 'git diff failed' };

  const files: DiffFileEntry[] = [];
  const tok = ns.stdout.split('\0');
  for (let i = 0; i < tok.length; ) {
    const status = tok[i];
    if (!status) break;
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = tok[i + 1];
      const newPath = tok[i + 2];
      i += 3;
      if (!oldPath || !newPath) break;
      if (letter === 'R') {
        files.push({ relPath: newPath, status: 'renamed', oldPath, binary: false });
      } else {
        files.push({ relPath: newPath, status: 'added', binary: false });
      }
      continue;
    }
    const path = tok[i + 1];
    i += 2;
    if (!path) break;
    const mapped: DiffFileStatus =
      letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
    files.push({ relPath: path, status: mapped, binary: false });
  }

  // Working-tree mode: untracked files never show up in `git diff` — append
  // them as additions so a brand-new file the agent just wrote is reviewable.
  if (!target) {
    const untracked = yield ['ls-files', '--others', '--exclude-standard', '-z'];
    if (untracked.ok) {
      const known = new Set(files.map((f) => f.relPath));
      for (const path of untracked.stdout.split('\0')) {
        if (path && !known.has(path)) {
          files.push({ relPath: path, status: 'added', binary: false });
        }
      }
    }
  }

  // Join in line counts; numstat reports "-\t-" for binary files.
  const num = yield [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--numstat',
    '-z',
    '-M',
    ...range,
    '--',
  ];
  if (num.ok) {
    const counts = parseNumstat(num.stdout);
    for (const f of files) {
      const c = counts.get(f.relPath);
      if (c) {
        f.additions = c.additions;
        f.deletions = c.deletions;
        f.binary = c.binary;
      }
    }

    // Second pass, whitespace-insensitive. Every file the plain pass listed
    // that this one drops changed only in whitespace. Restricted to files
    // that were MODIFIED: an add or a delete is never "only whitespace" in
    // any useful sense, and an untracked file appears in neither numstat.
    // `-w` covers indentation and trailing space but NOT added/removed blank
    // lines, which every formatter also produces — `--ignore-blank-lines` is
    // a separate flag and both are needed to describe "a formatter ran".
    const ws = yield [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '-w',
      '--ignore-blank-lines',
      '--numstat',
      '-z',
      '-M',
      ...range,
      '--',
    ];
    if (ws.ok) {
      const survives = parseNumstat(ws.stdout);
      for (const f of files) {
        if (f.binary) continue;
        if (f.status !== 'modified' && f.status !== 'renamed') continue;
        if (!counts.has(f.relPath)) continue; // not in the plain pass either
        if (!survives.has(f.relPath)) f.whitespaceOnly = true;
      }
    }
  }

  return { ok: true, files };
}

/** Read a file's bytes at a commit. Returns null when the path doesn't exist there. */
export function showFile(repo: string, commit: string, relPath: string): string | null {
  const res = gitSync(repo, ['show', `${commit}:${relPath}`]);
  return res.ok ? res.stdout : null;
}

/** Cheap binary sniff on already-read content (NUL in the first 8 KB). */
export function textLooksBinary(text: string): boolean {
  const len = Math.min(text.length, 8 * 1024);
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}

/**
 * The ref a builder's branch is a departure FROM: the upstream default
 * branch, asked of the repo rather than assumed.
 *
 * `origin/HEAD` is the answer when the clone has one — it is the symbolic ref
 * git writes at clone time naming the remote's default branch, so it is right
 * on a repo whose trunk is `master`, `trunk` or anything else. A clone made
 * with `--single-branch`, or one whose `origin/HEAD` was never fetched, has
 * none; the two fallbacks cover the overwhelming majority of those, and a
 * repo past all three reads as "cannot tell", which every caller here treats
 * as no evidence rather than as a verdict.
 */
export function defaultBaseRef(repo: string): string | null {
  return runSync(repo, defaultBaseRefSteps());
}

function* defaultBaseRefSteps(): GitSteps<string | null> {
  const head = yield ['rev-parse', '--abbrev-ref', 'origin/HEAD'];
  const named = head.stdout.trim();
  const candidates = new Set<string>();
  if (head.ok && named.length > 0 && isSafeRef(named)) candidates.add(named);
  candidates.add('origin/main');
  candidates.add('origin/master');

  // The closest trunk wins, not the first one that answers. `origin/HEAD` is
  // written at clone time and git never refreshes it, so a repo that renamed
  // master to main and kept the old branch points a builder at a trunk it
  // left long ago — and every file somebody else has landed on the real one
  // since then reads as this builder's work. That is the false positive this
  // whole read exists to remove, arriving by a different door.
  let best: { ref: string; mergeBase: string } | null = null;
  for (const ref of candidates) {
    if ((yield* resolveCommitSteps(ref)) === null) continue;
    const mb = yield ['merge-base', 'HEAD', ref];
    const mergeBase = mb.stdout.trim();
    if (!mb.ok || !isObjectId(mergeBase)) continue;
    if (
      best === null ||
      (best.mergeBase !== mergeBase && (yield* isAncestorSteps(best.mergeBase, mergeBase)))
    )
      best = { ref, mergeBase };
  }
  return best?.ref ?? null;
}

/** Is `a` an ancestor of `b` (or the same commit)? */
function* isAncestorSteps(a: string, b: string): GitSteps<boolean> {
  return (yield ['merge-base', '--is-ancestor', a, b]).ok;
}

export interface WorktreeChanges {
  /** Every path the worktree has changed since `from`. */
  files: string[];
  /**
   * Which starting line that was measured from: `dispatch` is the commit
   * recorded when this dispatch took the checkout, `trunk` the default
   * branch's merge base. The fallback is not neutral — `trunk` is the read
   * that hands one task the work of whoever held the worktree before it, so
   * anything that judges a builder off this list must be able to say which
   * of the two it got.
   */
  from: 'dispatch' | 'trunk';
}

/**
 * Every file a worktree has changed since it left the default branch —
 * committed and uncommitted alike, untracked files included.
 *
 * The base is the MERGE BASE, not the branch tip: a builder whose worktree is
 * a hundred commits behind main must not be told it changed every file main
 * moved on meanwhile. Reading to the working tree rather than to HEAD is the
 * other half of the same instinct — a builder is judged on what it has
 * written, not on what it has got round to committing.
 *
 * The baseline below pins COMMITTED history only, and this reads to the
 * working tree: a worktree handed on while the last occupant's edits were
 * still uncommitted attributes them to whoever holds it now. Committing
 * before the handover is what the registry's own dispatch flow does; a
 * baseline cannot reach work that has no commit.
 *
 * `since` narrows it to one stretch of that branch's life: pass the commit a
 * worktree was sitting on when its CURRENT occupant took it, and the read
 * stops attributing the previous occupant's work to this one. It is used only
 * when it is both a descendant of the merge base and an ancestor of HEAD —
 * so a recorded commit that has been rebased away, or that belongs to a
 * branch this worktree has since left, falls back to the merge base rather
 * than producing a diff about nothing.
 *
 * A RENAME contributes both paths. A builder who moves a screen out of the
 * client tree changed a file a person looks at, and a list holding only the
 * destination says the opposite of what happened.
 *
 * `null` means the question could not be answered — not a repo, no default
 * branch, no merge base, a git that failed. It is deliberately a different
 * value from `{ files: [] }` ("a readable worktree that has changed nothing"), because
 * a caller that folded the two together would be asserting a fact about work
 * it could not see.
 */
export function changedFilesInWorktree(repo: string, since?: string): WorktreeChanges | null {
  return runSync(repo, changedFilesSteps(since));
}

/**
 * `changedFilesInWorktree` without holding the loop: the same reads, each git
 * process awaited rather than waited on. The stall tick's timer path uses it.
 */
export function changedFilesInWorktreeAsync(
  repo: string,
  since?: string,
): Promise<WorktreeChanges | null> {
  return runAsync(repo, changedFilesSteps(since));
}

function* changedFilesSteps(since?: string): GitSteps<WorktreeChanges | null> {
  const ref = yield* defaultBaseRefSteps();
  if (ref === null) return null;
  const mb = yield ['merge-base', 'HEAD', ref];
  const mergeBase = mb.stdout.trim();
  if (!mb.ok || !isObjectId(mergeBase)) return null;
  const usable =
    since !== undefined &&
    (yield* resolveCommitSteps(since)) !== null &&
    (yield* isAncestorSteps(mergeBase, since)) &&
    (yield* isAncestorSteps(since, 'HEAD'));
  const diff = yield* diffFilesSteps(usable && since !== undefined ? since : mergeBase, null);
  if (!diff.ok) return null;
  const files: string[] = [];
  for (const file of diff.files) {
    files.push(file.relPath);
    if (file.oldPath !== undefined && file.oldPath !== file.relPath) files.push(file.oldPath);
  }
  return { files, from: usable ? 'dispatch' : 'trunk' };
}
