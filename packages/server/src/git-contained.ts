/**
 * Git in a walled lead's repository, run so that nothing the lead wrote can
 * make it run a program, read a file outside the lead's root, or write.
 *
 * `gitBarred` (`git-hardening.ts`) still decides whether a path is in a
 * lead's repository. This module decides what an ASYNCHRONOUS caller gets
 * there: git under a deny-default Seatbelt profile the server writes from the
 * root alone, or "cannot tell". A synchronous caller keeps "cannot tell":
 * holding the event loop for every board while git runs is not worth it.
 *
 * - The profile reads the root, git's own prefix and the system libraries,
 *   execs the git binary only and writes nothing but `/dev/null`. So a hook,
 *   a `!` alias, `core.fsmonitor`, a filter, a `textconv`, `gpg.program` or a
 *   pager cannot start, and an `include.path`, `core.worktree` or alternates
 *   file outside the root reads as missing.
 * - The environment is fixed: none of the server's variables reach git.
 * - The neutralised settings go through `GIT_CONFIG_COUNT`, which does not
 *   split a key at `=` as `-c` does. Filter and diff drivers have names the
 *   repository chooses, so a sandboxed `git config --get-regexp` lists them
 *   first and each gets an empty command.
 * - Every call is bounded: a timeout, then SIGKILL.
 *
 * Design and tests: docs/architecture/lead-tree-containment.md.
 */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { boundFiles } from './slow-fs.ts';
import type { Contained } from './tree-fs.ts';
import { listTreeSync, readTreeSync } from './tree-fs.ts';

export interface ContainedGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const XCRUN = '/usr/bin/xcrun';
const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
/** The most entries one folder may hold while the repository is looked for. */
const DIR_SCAN_MAX = 100_000;

const cannotTell = (why: string): ContainedGitResult => ({ ok: false, stdout: '', stderr: why });

/** The settings every contained git runs with, as key/value pairs. */
export const NEUTRALISED: readonly (readonly [string, string])[] = [
  ['core.fsmonitor', 'false'],
  ['core.untrackedCache', 'false'],
  ['safe.bareRepository', 'explicit'],
  ['log.showSignature', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.pager', 'cat'],
  ['core.editor', 'false'],
  ['core.sshCommand', 'false'],
  ['core.askPass', ''],
  ['credential.helper', ''],
  ['gpg.program', 'false'],
  ['gpg.ssh.program', 'false'],
  ['gpg.x509.program', 'false'],
  ['protocol.allow', 'never'],
  ['core.alternateRefsCommand', ''],
  // Output pins: the callers parse git's output, and these change its shape.
  ['core.quotePath', 'true'],
  ['diff.noprefix', 'false'],
  ['diff.mnemonicPrefix', 'false'],
  ['diff.relative', 'false'],
  ['color.ui', 'false'],
];

let gitOverride: string | null = null;
let timeoutOverride: number | null = null;
let seam: ((cwd: string) => void) | null = null;
let layers = { sandbox: true, settings: true };

/**
 * Tests: turn one layer off, to show the other holds alone (the sandbox
 * with no neutralised settings, or the settings with no sandbox). Null
 * restores both.
 */
export function setContainedGitLayersForTest(
  next: { sandbox: boolean; settings: boolean } | null,
): void {
  layers = next ?? { sandbox: true, settings: true };
}

/** Tests: the binary run in place of git, or null for the real one. */
export function setContainedGitBinaryForTest(bin: string | null): void {
  gitOverride = bin;
}

/** Tests: the per-call bound, or null for 30s. */
export function setContainedGitTimeoutForTest(ms: number | null): void {
  timeoutOverride = ms;
}

/** Tests: called after the run conditions are checked and before the spawn. */
export function setContainedGitSeamForTest(fn: ((cwd: string) => void) | null): void {
  seam = fn;
}

let resolved: string | null | undefined;

/**
 * The git binary, resolved once and outside any sandbox. Xcode's git where
 * `xcrun` exists, so the `/usr/bin/git` shim is never what the profile
 * execs; otherwise the first `git` on `/usr/bin:/bin`. Real paths, because
 * Seatbelt matches the path a file really has.
 */
async function gitBinary(): Promise<string | null> {
  if (gitOverride) return gitOverride;
  if (resolved !== undefined) return resolved;
  resolved = await new Promise<string | null>((done) => {
    if (!existsSync(XCRUN)) {
      done(existsSync('/usr/bin/git') ? '/usr/bin/git' : null);
      return;
    }
    execFile(
      XCRUN,
      ['-f', 'git'],
      { env: { PATH: '/usr/bin:/bin' }, timeout: 10_000, killSignal: 'SIGKILL' },
      (err, stdout) => {
        const out = typeof stdout === 'string' ? stdout.trim() : '';
        if (err || !out.startsWith('/')) return done(null);
        try {
          done(realpathSync(out));
        } catch {
          done(null);
        }
      },
    );
  });
  return resolved;
}

/** Whether `text` can be written into the profile as a literal. */
const literalSafe = (text: string): boolean =>
  ![...text].some((ch) => ch === '"' || ch === '\\' || ch.charCodeAt(0) < 0x20 || ch === '\u007f');

/** The Seatbelt profile for one call: read `root` and git, exec git only. */
export function containedGitProfile(root: string, git: string): string {
  const prefix = dirname(dirname(git));
  const q = (p: string) => `"${p}"`;
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow file-read-metadata)',
    `(allow file-read* (literal "/") (subpath ${q(root)}) (subpath ${q(prefix)})` +
      ' (subpath "/usr/lib") (subpath "/System") (subpath "/private/var/db/dyld")' +
      ' (literal "/dev/null"))',
    '(allow file-write-data (literal "/dev/null"))',
    `(allow process-exec (literal ${q(git)}))`,
  ].join('\n');
}

/** The whole environment a contained git sees. */
export function containedGitEnv(
  root: string,
  settings: readonly (readonly [string, string])[],
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: '/var/empty',
    XDG_CONFIG_HOME: '/var/empty',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_CEILING_DIRECTORIES: dirname(root),
    GIT_CONFIG_COUNT: String(settings.length),
  };
  settings.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/**
 * The empty command for every filter driver a repository's config names
 * (git runs no filter whose command is empty). Diff and merge drivers are
 * not given one: an empty `diff.external` or `textconv` is a command git
 * tries to run, so those are turned off by `--no-ext-diff --no-textconv`
 * (`withReadFlags`) and, under that, by the profile.
 */
export function driverOverrides(names: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const first = name.indexOf('.');
    const last = name.lastIndexOf('.');
    if (first < 0 || last <= first) continue;
    const section = name.slice(0, first).toLowerCase();
    const driver = name.slice(first + 1, last);
    const key = `${section}\u0000${driver}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = `${section}.${driver}`;
    if (section === 'filter') {
      out.push([`${at}.clean`, ''], [`${at}.smudge`, ''], [`${at}.process`, '']);
      out.push([`${at}.required`, 'false']);
    }
  }
  return out;
}

/**
 * Whether git would find its repository inside `c.root`, from `c`: the first
 * `.git` on the way up from `c.abs` to the root is a folder, or a regular
 * file whose `gitdir:` names a path under the root. Read through tree-fs, so
 * a `.git` link is seen as one. A root with no `.git` inside it sits in a
 * larger repository, which this does not run git in.
 */
export function repoInsideRoot(c: Contained): boolean {
  let at = c.abs;
  for (;;) {
    const listed = listTreeSync(
      { root: c.root, abs: at },
      { maxEntries: DIR_SCAN_MAX, enter: () => false },
    );
    if (listed === null) return false;
    const base = at === c.root ? '' : `${at.slice(c.root.length + 1)}/`;
    const dotGit = listed.find((e) => e.rel === `${base}.git`);
    if (dotGit) {
      if (dotGit.kind === 'dir') return true;
      if (dotGit.kind !== 'file') return false;
      const bytes = readTreeSync({ root: c.root, abs: join(at, '.git') }, 4_096);
      if (bytes === 'too-large') return false;
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(Buffer.from(bytes).toString('utf8'))?.[1];
      if (!named) return false;
      const target = resolve(at, named);
      return target.startsWith(`${c.root}/`);
    }
    if (at === c.root) return false;
    at = dirname(at);
  }
}

/**
 * Whether a name git printed may be joined to its folder. Git's output is
 * the repository's text, and a crafted index can make it print `../x`; the
 * name is judged raw, before `join` would normalise it away.
 */
export function isSafeGitName(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || rel.includes('\0')) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** The subcommands that can run a diff driver or textconv. */
const DIFFING = new Set([
  'diff',
  'show',
  'log',
  'whatchanged',
  'format-patch',
  'diff-tree',
  'diff-files',
  'diff-index',
]);

/** `args` with `--no-ext-diff --no-textconv` after a diffing subcommand. */
export function withReadFlags(args: readonly string[]): string[] {
  const [cmd, ...rest] = args;
  if (cmd === undefined || !DIFFING.has(cmd)) return [...args];
  return [cmd, '--no-ext-diff', '--no-textconv', ...rest];
}

function run(
  git: string,
  profile: string,
  env: Record<string, string>,
  cwd: string,
  args: readonly string[],
): Promise<ContainedGitResult> {
  return new Promise((done) => {
    const [cmd, argv] = layers.sandbox
      ? [SANDBOX_EXEC, ['-p', profile, git, '-C', cwd, ...args]]
      : [git, ['-C', cwd, ...args]];
    execFile(
      cmd,
      argv,
      {
        encoding: 'utf8',
        env,
        cwd: '/',
        maxBuffer: MAX_BUFFER,
        timeout: timeoutOverride ?? DEFAULT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
      (err, stdout, stderr) => {
        done({
          ok: err === null,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      },
    );
  });
}

/**
 * `git -C cwd <args>` for a folder a walled lead's root holds, contained as
 * the header says. Null when no root holds `cwd` (the caller's own rules
 * apply); a failed result with `ok: false` when git cannot be run there
 * safely, which every caller reads as "cannot tell".
 */
export function containedGit(
  cwd: string,
  args: readonly string[],
): Promise<ContainedGitResult> | null {
  let c: Contained | null;
  try {
    c = boundFiles.guards.containedOf(cwd);
  } catch {
    return Promise.resolve(cannotTell('a path guard refused this folder'));
  }
  if (!c) return null;
  return runContained(c, args);
}

async function runContained(c: Contained, args: readonly string[]): Promise<ContainedGitResult> {
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) {
    return cannotTell('git runs in a lead folder only under sandbox-exec');
  }
  if (!literalSafe(c.root) || !literalSafe(c.abs)) {
    return cannotTell('this folder cannot be named in a sandbox profile');
  }
  try {
    if (!repoInsideRoot(c)) return cannotTell('no repository inside the lead folder');
  } catch {
    return cannotTell('the lead folder could not be read');
  }
  const git = await gitBinary();
  if (!git || !literalSafe(git)) return cannotTell('no git binary');
  const profile = containedGitProfile(c.root, git);
  seam?.(c.abs);
  const listed = await run(
    git,
    profile,
    containedGitEnv(c.root, layers.settings ? NEUTRALISED : []),
    c.abs,
    ['config', '-z', '--name-only', '--get-regexp', '^filter\\.'],
  );
  // Exit 1 is "no such key"; anything else with no output is a failure.
  const names = listed.stdout.split('\0').filter(Boolean);
  if (!listed.ok && names.length === 0 && listed.stderr.trim() !== '') {
    return cannotTell('git could not read its config here');
  }
  const settings = layers.settings ? [...NEUTRALISED, ...driverOverrides(names)] : [];
  return run(git, profile, containedGitEnv(c.root, settings), c.abs, withReadFlags(args));
}
