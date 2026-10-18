/**
 * Path containment that survives symlinks.
 *
 * Every "stay under the root" check in this server used to be a string
 * comparison over `path.join` / `path.resolve` output. Both are purely
 * LEXICAL — they normalize `..` without touching the filesystem — so a
 * symlink that lives inside the root and points outside it passes cleanly.
 * `serveStaticUnder` was fixed for this; `docStore.openContextFile` and
 * `docStore.openEditableFile` were not, and those two are reachable by a share
 * visitor on a workspace share, where the root can be a whole repository.
 *
 * The lexical check is still worth doing first (it rejects `..` without a
 * syscall, and gives a straight answer for paths that don't exist yet). This
 * is the second half: resolve what the path ACTUALLY points at and require
 * that to be under the resolved root.
 */
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';

/**
 * True when `abs` resolves to something inside `root`.
 *
 * BOTH sides are realpath'd, never just the target: on macOS a temp dir is
 * handed out as `/var/folders/...` while its real path is
 * `/private/var/folders/...`, so resolving only one side would reject every
 * legitimate file under it.
 *
 * A path that cannot be resolved — missing file, dangling symlink, no
 * permission to walk the ancestors — is NOT contained. Callers that want to
 * tell "outside the root" apart from "not there at all" should test existence
 * first; this answers one question only, and answers it closed.
 */
export function isWithinRoot(root: string, abs: string): boolean {
  let base: string;
  let target: string;
  try {
    base = realpathSync(root);
    target = realpathSync(abs);
  } catch {
    return false;
  }
  // The `${base}${sep}` suffix matters: a sibling whose name merely STARTS
  // with the root's (`/repo-evil` next to `/repo`) would pass a bare
  // startsWith.
  return target === base || target.startsWith(`${base}${sep}`);
}

/**
 * Where `abs` really lands, as a `/`-separated path under `root`: `''` for
 * the root itself, `null` when it resolves outside the root or not at all.
 *
 * For a caller whose rule is about NAMES — a listing, an exclude, a
 * credential floor — rather than containment alone. A symlink is listed
 * under its own name, so asking the rule about that name judges the link
 * and not the file it serves; ask it about this answer as well.
 */
export function realPathUnder(root: string, abs: string): string | null {
  let base: string;
  let target: string;
  try {
    base = realpathSync(root);
    target = realpathSync(abs);
  } catch {
    return null;
  }
  if (target === base) return '';
  if (!target.startsWith(`${base}${sep}`)) return null;
  return target
    .slice(base.length + 1)
    .split(sep)
    .join('/');
}
