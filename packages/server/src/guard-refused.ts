/**
 * The error a guarded read or write throws when the file is not where its
 * guard allows (`bound-path-guard.ts`, `tree-fs.ts`), and the path form it
 * may name in a log line. Its own module so that both can throw it without
 * importing each other.
 */
import { homedir } from 'node:os';
import { basename, sep } from 'node:path';

/**
 * Home-relative folders whose full paths must not reach a log line. The files
 * most likely to appear in a quarantine line live in a cloud-sync folder, and
 * these logs get pasted into tickets and PR bodies. Only these two are
 * redacted: a bound doc under a checkout is the ordinary case, and its path is
 * what makes the line useful.
 */
const PRIVATE_ROOTS = ['Dropbox', 'Documents'];

/**
 * A path safe to log: the basename alone under a private root, else the path.
 * Exported so the test runs the real function rather than a copy of its rule.
 */
export function redactBoundPath(path: string): string {
  const home = homedir();
  for (const root of PRIVATE_ROOTS) {
    const prefix = `${home}${sep}${root}${sep}`;
    if (path.startsWith(prefix)) return `<${root}>/${basename(path)}`;
  }
  return path;
}

/** A guarded read or write refused because the file is not where its guard
 *  allows. Never retried into a backoff: the file is not sick. */
export class GuardRefused extends Error {
  constructor(path: string, why = 'it no longer lands inside its bound folder') {
    super(`a path guard refused ${redactBoundPath(path)}: ${why}`);
  }
}
