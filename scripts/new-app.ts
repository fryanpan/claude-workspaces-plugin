#!/usr/bin/env bun
/**
 * `bun run new-app <dir>`: start a new app from the app kit.
 *
 * Copies `templates/app-kit` into `<dir>` and names it after the folder. The
 * made app gets the collab core and the shared theme as one versioned
 * package, `@claude-workspaces/app-kit`: the generator packs it
 * (`packages/app-kit/scripts/pack.ts`) into `<dir>/vendor/` and names that
 * tarball in the app's `package.json`, so the app holds no copy of their
 * source and depends on nothing in this repo.
 *
 * The app's `fly.toml` names its staging app `<dir name>-staging`, the name
 * `bun run deploy:staging` deploys to unless given another.
 *
 * A relative `<dir>` is read from the repo root, wherever the command was
 * typed. Refuses a `<dir>` that exists and is not empty. Prints the next steps.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { packKit } from '../packages/app-kit/scripts/pack.ts';

export const REPO = resolve(import.meta.dirname, '..');
export const TEMPLATE = join(REPO, 'templates/app-kit');
const KIT = '@claude-workspaces/app-kit';

/** npm's rule for a package name, lower case only: what `name` may be. */
const APP_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** Never copied: what a build, an install or a run leaves behind. */
const SKIP = new Set(['node_modules', 'dist', 'data']);

/**
 * `bun run` starts a root script in the repo root and passes on no trace of
 * where it was typed, so a relative `<dir>` is read from the repo root.
 */
export function makeApp(dir: string): { dir: string; name: string; kit: string } {
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

  const tarball = packKit(join(target, 'vendor'));
  const kit = `file:./${relative(target, tarball)}`;

  const pkgPath = join(target, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    name: string;
    dependencies: Record<string, string>;
  };
  const dependencies = { ...pkg.dependencies, [KIT]: kit };
  writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, name, dependencies }, null, 2)}\n`);

  // The staging app `bun run deploy:staging` makes, named after this one.
  const flyPath = join(target, 'fly.toml');
  const fly = readFileSync(flyPath, 'utf8');
  writeFileSync(flyPath, fly.replace(/^app = ".*"$/m, `app = "${name}-staging"`));
  return { dir: target, name, kit };
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
    console.log(`made ${made.name} in ${made.dir}, on ${KIT} ${made.kit}

  cd ${made.dir}
  bun install
  bun run build
  bun run start        # http://127.0.0.1:3000, PORT=0 picks a free port`);
  } catch (err) {
    console.error(String((err as Error).message ?? err));
    process.exit(1);
  }
}
