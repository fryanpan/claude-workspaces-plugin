#!/usr/bin/env bun
/**
 * The import-direction gate for the server's HTTP layer.
 *
 * `.claude/rules/code-health.md` ("A route lives in `routes/`") says imports
 * point one way: `server.ts` → `routes/` → everything else. Two edges break
 * that, and both had shipped before this gate existed:
 *
 *  - **routes → server.ts.** `routes/meetings-calendar.ts` imported
 *    `ServerOptions` out of `server.ts`, which imports `routes/` back. A cycle
 *    as well as an upward import, and invisible because it was `import type`
 *    — six other modules had already worked around it by hand-copying the two
 *    or three option fields they read into a structural type.
 *  - **non-route → routes.** `review-gate.ts`, a service, imported the two
 *    verdict types it PRODUCES back out of `routes/docs.ts` and
 *    `routes/task-routes-context.ts`. A shared name both a route and a service
 *    need belongs with the service; the route context re-exports it.
 *
 * `server.ts` is the one module allowed to import `routes/`, because it is the
 * router: that is what makes the direction a direction rather than a ban.
 *
 * A third edge comes from outside the package. The MCP child reads the route
 * contracts' TYPES, and it reads them through one door,
 * `routes/contracts.ts`. They used to be re-exported from `server.ts` and
 * again from `index.ts`, so adding a contract meant an export-only edit to the
 * router, and 16 of its 97 commits were nothing else. Another package naming
 * any other file under `routes/` is the drift that barrel exists to stop.
 *
 * Type-only imports count. Both edges above were `import type`, and a rule
 * that ignored them would have caught neither.
 *
 * The scan is textual on purpose. It reads import specifiers out of the
 * source, resolves them against the file's own directory, and asks which side
 * of `routes/` each end sits on. There is no build step to keep in sync and
 * nothing to configure; a new package under `packages/` is covered the moment
 * its files exist.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// `import.meta.url`, not Bun's `import.meta.dir`: the colocated test runs
// under vitest, where `import.meta.dir` is undefined and module load throws.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The server package's source root, relative to the repo. */
export const SRC_ROOT = posix.join('packages', 'server', 'src');
/** The router — the one module that may import out of `routes/`. */
export const ROUTER = posix.join(SRC_ROOT, 'server.ts');
/** The route directory, with its trailing separator so a prefix test cannot
 *  match a sibling named `routes-something.ts`. */
export const ROUTES_DIR = `${posix.join(SRC_ROOT, 'routes')}/`;
/** The one file under `routes/` another package may import: the typed route
 *  contracts, as types. */
export const CONTRACTS = `${ROUTES_DIR}contracts.ts`;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

/** One offending edge: who imported what, and which rule it broke. */
export interface Violation {
  /** Repo-relative path of the importing file. */
  from: string;
  /** Repo-relative path of the imported file. */
  to: string;
  /** The specifier as written, so the message names something greppable. */
  specifier: string;
  rule: 'routes-imports-server' | 'non-route-imports-routes' | 'package-imports-routes';
}

/** Normalise a path to forward slashes, so the checks read the same on
 *  Windows as they do on the box this ships from. */
export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

export function isRoute(repoRelPath: string): boolean {
  return repoRelPath.startsWith(ROUTES_DIR);
}

/**
 * Every relative import specifier in a source file.
 *
 * Static `import`/`export … from`, plus dynamic `import(...)`. Bare
 * specifiers (`@claude-workspaces/core`, `node:fs`) are skipped: they cannot name a
 * file inside this package, so they cannot be either edge.
 */
export function relativeSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g;
  for (const m of source.matchAll(re)) {
    const spec = m[1];
    if (spec) out.push(spec);
  }
  return out;
}

/** Resolve one specifier against the importing file, as a repo-relative
 *  posix path. Specifiers in this repo always carry their `.ts` extension. */
export function resolveSpecifier(fromRepoRel: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(fromRepoRel), specifier));
}

/** The edges one file's imports produce that break the direction. */
export function violationsIn(fromRepoRel: string, source: string): Violation[] {
  const from = toPosix(fromRepoRel);
  const found: Violation[] = [];
  if (!from.startsWith(`${SRC_ROOT}/`)) {
    for (const specifier of relativeSpecifiers(source)) {
      const to = resolveSpecifier(from, specifier);
      if (isRoute(to) && to !== CONTRACTS) {
        found.push({ from, to, specifier, rule: 'package-imports-routes' });
      }
    }
    return found;
  }
  for (const specifier of relativeSpecifiers(source)) {
    const to = resolveSpecifier(from, specifier);
    if (isRoute(from) && to === ROUTER) {
      found.push({ from, to, specifier, rule: 'routes-imports-server' });
    } else if (!isRoute(from) && from !== ROUTER && isRoute(to)) {
      found.push({ from, to, specifier, rule: 'non-route-imports-routes' });
    }
  }
  return found;
}

export function walk(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, root, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(toPosix(relative(root, abs)));
    }
  }
  return out;
}

/** Every package's `src/`: the server's for the two inner edges, the rest
 *  for the edge into `routes/` from outside. Tests are not read — a server
 *  test drives a route module directly, and that is the point of it. */
function sourceDirs(root: string): string[] {
  const pkgs = join(root, 'packages');
  try {
    return readdirSync(pkgs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(pkgs, e.name, 'src'))
      .filter((d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

export function audit(root: string): Violation[] {
  const files = sourceDirs(root).flatMap((d) => walk(d, root));
  const found: Violation[] = [];
  for (const rel of files) {
    found.push(...violationsIn(rel, readFileSync(join(root, ...rel.split('/')), 'utf8')));
  }
  return found.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

const EXPLAIN: Record<Violation['rule'], string> = {
  'routes-imports-server':
    'a route may not import server.ts — server.ts imports routes/ back, so this is a cycle. Shared config types live in server-options.ts.',
  'non-route-imports-routes':
    'only server.ts may import out of routes/ — a service that needs a name a route also needs should own it, with the route context re-exporting it (see review-gate-types.ts).',
  'package-imports-routes':
    'another package reads routes/ only through routes/contracts.ts — add the type to that barrel and import it from there.',
};

function main(): number {
  const violations = audit(REPO_ROOT);
  if (violations.length === 0) {
    console.log(`✅ import direction holds: ${ROUTER} → ${ROUTES_DIR} → everything else.`);
    return 0;
  }
  console.error(`❌ ${violations.length} import(s) point the wrong way:\n`);
  for (const v of violations) {
    console.error(`  ${v.from}`);
    console.error(`    imports '${v.specifier}' → ${v.to}`);
    console.error(`    ${EXPLAIN[v.rule]}\n`);
  }
  console.error('See "A route lives in `routes/`" in .claude/rules/code-health.md.');
  return 1;
}

if (import.meta.main) process.exit(main());
