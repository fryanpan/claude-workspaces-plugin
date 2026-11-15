#!/usr/bin/env bun
/**
 * `bun run new-app <dir>`: start a new app from the app kit.
 *
 * Copies `templates/app-kit` into `<dir>` and names it after the folder. The
 * made app stands alone: two template files that point back into this repo
 * are replaced by copies of what they point at.
 *
 *   src/collab/   the template re-exports `@claude-workspaces/core/collab`;
 *                 the app gets the core's own files. They import only yjs,
 *                 y-protocols and lib0 (`core/test/collab/collab-imports.test.ts`).
 *   src/theme.css the template imports the board's theme file; the app gets
 *                 a copy of it (`packages/workspaces-app/src/wa-theme.css`).
 *
 * A relative `<dir>` is read from the repo root, wherever the command was
 * typed. Refuses a `<dir>` that exists and is not empty. Prints the next steps.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '..');
export const TEMPLATE = join(REPO, 'templates/app-kit');
const CORE_COLLAB = join(REPO, 'packages/core/src/collab');
const THEME = join(REPO, 'packages/workspaces-app/src/wa-theme.css');

/** npm's rule for a package name, lower case only: what `name` may be. */
const APP_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** Never copied: what a build, an install or a run leaves behind. */
const SKIP = new Set(['node_modules', 'dist', 'data']);

/**
 * `bun run` starts a root script in the repo root and passes on no trace of
 * where it was typed, so a relative `<dir>` is read from the repo root.
 */
export function makeApp(dir: string): { dir: string; name: string } {
  const target = resolve(REPO, dir);
  const name = basename(target);
  if (!APP_NAME.test(name)) {
    throw new Error(
      `the folder name is the app's name, so it must be lower case letters, digits and -: ${JSON.stringify(name)}`,
    );
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`${target} exists and is not empty`);
  }
  mkdirSync(target, { recursive: true });
  cpSync(TEMPLATE, target, {
    recursive: true,
    filter: (src) => !SKIP.has(basename(src)) || src === TEMPLATE,
  });

  const collab = join(target, 'src/collab');
  rmSync(collab, { recursive: true, force: true });
  cpSync(CORE_COLLAB, collab, {
    recursive: true,
    filter: (src) => !src.endsWith('.test.ts'),
  });
  cpSync(THEME, join(target, 'src/theme.css'));

  const pkgPath = join(target, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    name: string;
    dependencies: Record<string, string>;
  };
  const { '@claude-workspaces/core': _repoOnly, ...dependencies } = pkg.dependencies;
  writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, name, dependencies }, null, 2)}\n`);
  return { dir: target, name };
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error(
      'usage: bun run new-app <dir>   (the folder name becomes the app name; a relative <dir> is read from the repo root)',
    );
    process.exit(2);
  }
  try {
    const made = makeApp(dir);
    console.log(`made ${made.name} in ${made.dir}

  cd ${made.dir}
  bun install
  bun run build
  bun run start        # http://127.0.0.1:3000, PORT=0 picks a free port`);
  } catch (err) {
    console.error(String((err as Error).message ?? err));
    process.exit(1);
  }
}
