/**
 * The one git route to the owner's commands the wall cannot close by itself.
 * It makes every git folder setting read only (`gitCodeRegex`), but
 * `core.hooksPath` may name a folder inside a project, such as a tracked
 * `.githooks/`, and those are ordinary files the lead writes. The owner's
 * next commit or push would run them. So `lead-sandbox.ts` refuses to wall a
 * lead whose project has one; the owner moves the hooks outside the lead's
 * projects, or unsets the setting, and launches again.
 */
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';

/** `core.hooksPath` as git in `project` reads it, every config level, or null. */
export function gitHooksPath(project: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const r = spawnSync('git', ['-C', project, 'config', '--get', '--type=path', 'core.hooksPath'], {
    encoding: 'utf8',
    env,
    timeout: 5_000,
  });
  const value = r.status === 0 ? r.stdout.trim() : '';
  return value === '' ? null : value;
}

/** Why these projects may not be walled, or null. A relative hooks path is
 *  read from each worktree's top, which is inside the project. */
export function hooksPathRefusal(
  projects: readonly string[],
  hooksPathOf: (project: string) => string | null,
  realpath: (p: string) => string,
): string | null {
  // A folder not made yet is resolved through its nearest existing parent.
  const real = (p: string): string => {
    try {
      return realpath(p);
    } catch {
      const parent = dirname(p);
      return parent === p ? p : join(real(parent), basename(p));
    }
  };
  const ends = projects.flatMap((p) => [p, real(p)]);
  const inside = (p: string) => ends.some((e) => p === e || p.startsWith(`${e}/`));
  for (const project of projects) {
    const hooks = hooksPathOf(project);
    if (hooks === null) continue;
    const abs = resolve(project, hooks);
    if (!hooks.startsWith('/') || inside(abs) || inside(real(abs)))
      return `core.hooksPath in ${project} is ${hooks}, inside a project the lead writes, so the owner's next commit would run what the lead put there. Point it at a folder outside the lead's projects, or unset it.`;
  }
  return null;
}
