/**
 * The day a file last changed in git, for a metadata field whose schema says
 * `x-workspaces-default: "git-last-modified"` (core `doc-metadata.ts`).
 *
 * Asynchronous, bounded, and with git's settings hardened as every server git
 * call is (`git-hardening.ts`). A path in a walled lead's tree answers null
 * before git starts: `log` is not one of the subcommands the contained git
 * runs (docs/architecture/lead-tree-containment.md, section I), and a blank
 * default is what a file outside a repository gets anyway.
 */
import { execFile } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { gitBarred, hardenedGitArgs, hardenedGitEnv } from './git-hardening.ts';

const TIMEOUT_MS = 2_000;

/** `YYYY-MM-DD` of the last commit that touched `path`, or null. */
export function gitLastModified(path: string): Promise<string | null> {
  const cwd = dirname(path);
  if (gitBarred(cwd)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'git',
      hardenedGitArgs(['log', '-1', '--format=%cs', '--', basename(path)]),
      {
        cwd,
        env: hardenedGitEnv(),
        timeout: TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      },
      (err, stdout) => {
        const day = String(stdout ?? '').trim();
        resolve(!err && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null);
      },
    );
  });
}
