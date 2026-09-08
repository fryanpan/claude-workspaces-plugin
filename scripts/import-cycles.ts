#!/usr/bin/env bun
/**
 * The import-cycle gate for the packages a BROWSER loads.
 *
 * WHY THIS EXISTS. PR 817 shipped a client that rendered chrome and no body
 * on every doc page in prod. The bundle threw `ReferenceError: kO8 is not
 * defined` while tiptap was constructing the editor, and the cause was a
 * three-module loop in `packages/core/src`:
 *
 *   prose.ts → prose-batch.ts → suggest-ops.ts → prose.ts
 *
 * `suggest-ops.ts` only wanted eight leaf symbols, and reached them through
 * the `prose.ts` barrel because the barrel re-exports everything. That closed
 * a loop, and a loop is not an error in ESM: the module graph is evaluated in
 * some order, and one participant necessarily runs while another's bindings
 * are still in their temporal dead zone. Whether that matters depends on
 * WHEN each binding is read. Unbundled — vitest, `bun test`, the server — the
 * reads happened late enough to be fine, so all sixteen `verify` members and
 * all eight CI checks stayed green. In the browser bundle, Bun's module
 * ordering put the read first, and the whole editor died on it.
 *
 * So the lesson is not "that one edge was bad". It is that a cycle makes
 * correctness depend on evaluation order, and evaluation order differs
 * between the runner that tests the code and the bundler that ships it. This
 * gate removes the class: no cycles at all in the two source trees a browser
 * loads. `scripts/client-boot-check.ts` is the other half — it boots the real
 * bundle, and catches an ordering fault whatever its shape.
 *
 * WHY TEXTUAL. Same reason as `scripts/import-direction.ts`, whose specifier
 * scanner and directory walk this reuses: there is no build step to keep in
 * sync, `import type` counts (a type-only edge still closes a loop for the
 * bundler's own graph), and a new file is covered the moment it exists.
 *
 *   bun run check:import-cycles
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecifier, toPosix, walk } from './import-direction.ts';

// `import.meta.url`, not Bun's `import.meta.dir`: the colocated test runs
// under vitest, where `import.meta.dir` is undefined and module load throws.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The trees a browser loads. `packages/core/src` is shared with the server,
 * but it is bundled into the client, so a cycle there is a client bug — which
 * is exactly where the one that shipped lived.
 */
export const SCANNED_ROOTS = [
  posix.join('packages', 'core', 'src'),
  posix.join('packages', 'workspaces-app', 'src'),
];

/** A cycle, as the sequence of repo-relative files that closes it. The first
 *  and last entries are the same file, so the loop reads end to end. */
export type Cycle = string[];

/**
 * Relative import specifiers that SURVIVE to runtime.
 *
 * Type-only edges are excluded, and that exclusion is the difference between
 * a gate people keep and a gate people turn off. `import type { X } from
 * './y.ts'` is erased by tsc and by the bundler alike: no `require`, no
 * binding, no evaluation-order question, and therefore no way to produce the
 * failure this gate exists for. Two of the loops standing in this repo the
 * day it was written — `schedule-missed ↔ task-schedule`, and
 * `anchor/text-range → anchor/index` — are type-only in at least one
 * direction and do not exist in any bundle. Counting them would have meant
 * shipping the gate with a baseline of exceptions, and a baseline is where a
 * gate goes to become a formality.
 *
 * The contrast is `anchor/element.ts`, which imports `SCORE_THRESHOLD` — a
 * value — out of the barrel that imports it back. That IS a runtime loop, of
 * the same shape as the one that took every doc page down, so this reports it.
 *
 * Three forms count as type-only: a leading `import type` / `export type`, and
 * a braced clause whose every named specifier carries its own `type` prefix.
 * `import * as Y` and a default import are always runtime. Anything this
 * cannot parse is treated as runtime, so the failure direction is a false
 * POSITIVE the author can see and argue with, never a silent miss.
 */
export function runtimeSpecifiers(source: string): string[] {
  const out: string[] = [];
  // The clause between `import`/`export` and `from`, then the specifier.
  const re = /\b(import|export)\s+(type\s+)?([^'"]*?)\s*from\s*['"](\.[^'"]*)['"]/g;
  for (const m of source.matchAll(re)) {
    const [, , typeKeyword, clause, specifier] = m;
    if (typeKeyword) continue;
    if (clause !== undefined && allSpecifiersAreTypeOnly(clause)) continue;
    if (specifier) out.push(specifier);
  }
  // Bare side-effect imports (`import './x.ts'`) and dynamic `import('./x.ts')`
  // have no clause and are always runtime.
  for (const m of source.matchAll(/\bimport\s*\(?\s*['"](\.[^'"]*)['"]/g)) {
    const spec = m[1];
    if (spec) out.push(spec);
  }
  return out;
}

/** True for a braced clause in which every named specifier is `type`-prefixed —
 *  `{ type A, type B }`. A clause with a namespace or default binding, or one
 *  bare name, is runtime. */
function allSpecifiersAreTypeOnly(clause: string): boolean {
  const braced = /^\{([^}]*)\}$/.exec(clause.trim());
  if (!braced) return false;
  const names = (braced[1] ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  return names.length > 0 && names.every((n) => /^type\s/.test(n));
}

/**
 * The runtime import graph of one source root: file → the files it imports
 * that are also inside that root.
 *
 * Edges leaving the root are dropped rather than followed. A cycle that
 * crosses package boundaries would be a real finding too, but every specifier
 * that leaves is a bare one (`@claude-workspaces/core`) whose resolution needs
 * the package's exports map — and the loop this gate exists for, like every
 * loop a bundler orders, was inside a single directory.
 */
export function buildGraph(root: string, files: readonly string[]): Map<string, string[]> {
  const inRoot = new Set(files);
  const graph = new Map<string, string[]>();
  for (const rel of files) {
    const abs = join(root, ...rel.split('/'));
    const edges: string[] = [];
    for (const specifier of runtimeSpecifiers(readFileSync(abs, 'utf8'))) {
      const to = resolveSpecifier(rel, specifier);
      if (inRoot.has(to) && to !== rel) edges.push(to);
    }
    graph.set(rel, edges);
  }
  return graph;
}

/**
 * Every cycle in a graph, each reported once.
 *
 * A depth-first walk carrying its own stack: when an edge reaches a node that
 * is on the current stack, the slice from that node to the top IS the cycle.
 * Cycles are keyed by their sorted member set, so the same loop found from
 * three different entry points is reported once — otherwise a three-module
 * loop prints three times and reads like three bugs.
 */
export function findCycles(graph: Map<string, string[]>): Cycle[] {
  const seen = new Set<string>();
  const onStack: string[] = [];
  const stackIndex = new Map<string, number>();
  const found = new Map<string, Cycle>();

  const visit = (node: string): void => {
    const at = stackIndex.get(node);
    if (at !== undefined) {
      const loop = onStack.slice(at);
      const key = [...loop].sort().join('|');
      if (!found.has(key)) found.set(key, [...loop, node]);
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    stackIndex.set(node, onStack.length);
    onStack.push(node);
    for (const next of graph.get(node) ?? []) visit(next);
    onStack.pop();
    stackIndex.delete(node);
  };

  // Sorted, so the reported entry point of a cycle does not depend on
  // readdir order and the message is the same on every machine.
  for (const node of [...graph.keys()].sort()) visit(node);
  return [...found.values()];
}

/** Every cycle under one repo-relative source root. A root that does not
 *  exist yields nothing rather than throwing — a package may be removed. */
export function auditRoot(repoRoot: string, rootRel: string): Cycle[] {
  const abs = join(repoRoot, ...rootRel.split('/'));
  try {
    if (!statSync(abs).isDirectory()) return [];
  } catch {
    return [];
  }
  const files = walk(abs, repoRoot)
    .map(toPosix)
    .filter((f) => !f.endsWith('.test.ts'));
  return findCycles(buildGraph(repoRoot, files));
}

export function audit(repoRoot: string, roots: readonly string[] = SCANNED_ROOTS): Cycle[] {
  return roots.flatMap((r) => auditRoot(repoRoot, r));
}

function main(): number {
  const cycles = audit(REPO_ROOT);
  if (cycles.length === 0) {
    console.log(`✅ no import cycles in ${SCANNED_ROOTS.join(', ')}.`);
    return 0;
  }
  console.error(`❌ ${cycles.length} import cycle(s):\n`);
  for (const cycle of cycles) {
    console.error(`  ${cycle.join('\n    → ')}\n`);
  }
  console.error(
    'A cycle makes correctness depend on module evaluation order, and the bundler\n' +
      'orders differently from vitest and bun — PR 817 shipped a client that threw\n' +
      'ReferenceError at editor construction for exactly this reason, with every\n' +
      'other gate green. Import from the leaf module that defines the symbol, not\n' +
      'from a barrel that re-exports the module you are imported by.',
  );
  return 1;
}

if (import.meta.main) process.exit(main());
