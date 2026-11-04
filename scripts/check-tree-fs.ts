#!/usr/bin/env bun
/**
 * The lead-tree gate: no module in `packages/server/src` or
 * `packages/core/src` gets file or spawn access without a row in
 * `scripts/check-tree-fs-table.ts` saying how it stands toward a walled
 * lead's folders (docs/architecture/lead-tree-containment.md, "The gate").
 *
 * A module needs a row when it does any of these, by import and not by name:
 *
 * - imports `fs`, `fs/promises` or `child_process`, with or without `node:`,
 *   statically, with `import()` or with `require()`;
 * - uses `Bun.file`, `Bun.write`, `Bun.spawn` or `Bun.spawnSync`;
 * - imports `@claude-workspaces/core/safe-file` (or `./safe-file` in core);
 * - calls one of the checked helpers (`readChecked`, `readLine`, …), which
 *   reach a file without the module importing `fs`.
 *
 * It fails for a module with no row, for a row whose module no longer exists
 * or no longer does any of those, for a module other than
 * `bound-path-guard.ts` importing `bound-path-checked.ts`, and for a module
 * other than `tree-fs-create.ts` naming `treeInternals`. The labels are
 * claims a reviewer reads; what the gate guarantees is that a new module
 * cannot reach a file without somebody writing one down.
 *
 * Parsed with the TypeScript compiler, so a comment or a string cannot trip it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { TREE_FS_TABLE } from './check-tree-fs-table.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCANNED = ['packages/server/src', 'packages/core/src'];

const IO_MODULES = new Set(['fs', 'fs/promises', 'child_process']);
const BUN_IO = new Set(['file', 'write', 'spawn', 'spawnSync']);
export const HELPERS = new Set([
  'readChecked',
  'readCheckedSync',
  'readBytesChecked',
  'readRangeChecked',
  'statChecked',
  'writeChecked',
  'writeCheckedSync',
  'readLine',
]);
const CHECKED = 'packages/server/src/bound-path-checked.ts';
const CHECKED_IMPORTER = 'packages/server/src/bound-path-guard.ts';
const INTERNALS_USER = 'packages/server/src/tree-fs-create.ts';
const INTERNALS_HOME = 'packages/server/src/tree-fs.ts';

export interface Reach {
  /** Why the module needs a row; empty when it needs none. */
  reasons: string[];
  /** Module specifiers it imports, as written. */
  imports: string[];
  namesInternals: boolean;
}

const bare = (spec: string): string => spec.replace(/^node:/, '');

/** What one file's source does that the gate looks for. */
export function reachOf(file: string, src: string): Reach {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const reasons = new Set<string>();
  const imports: string[] = [];
  let namesInternals = false;
  const spec = (s: string) => {
    imports.push(s);
    if (IO_MODULES.has(bare(s))) reasons.add(`imports ${s}`);
    if (s === '@claude-workspaces/core/safe-file' || /\/safe-file(\.ts)?$/.test(s)) {
      reasons.add('imports safe-file');
    }
  };
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      spec(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n)) {
      const [arg] = n.arguments;
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      if ((isImport || isRequire) && arg && ts.isStringLiteralLike(arg)) spec(arg.text);
      if (ts.isIdentifier(n.expression) && HELPERS.has(n.expression.text)) {
        reasons.add(`calls ${n.expression.text}`);
      }
    }
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'Bun' &&
      BUN_IO.has(n.name.text)
    ) {
      reasons.add(`uses Bun.${n.name.text}`);
    }
    if (ts.isIdentifier(n) && n.text === 'treeInternals') namesInternals = true;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { reasons: [...reasons].sort(), imports, namesInternals };
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test' || name === 'dist') continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (
      /\.(ts|tsx|mts)$/.test(name) &&
      !/\.test\.tsx?$/.test(name) &&
      !name.endsWith('.d.ts')
    ) {
      out.push(abs);
    }
  }
}

const importsChecked = (root: string, rel: string, specs: string[]): boolean =>
  specs.some(
    (s) => s.startsWith('.') && resolve(dirname(join(root, rel)), s) === resolve(root, CHECKED),
  );

/** Every problem the gate reports, over `files` (repo-relative) and `table`. */
export function audit(
  root: string,
  files: string[],
  table: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const rel of files) {
    const reach = reachOf(rel, readFileSync(join(root, rel), 'utf8'));
    seen.add(rel);
    const row = table[rel];
    if (reach.reasons.length > 0 && row === undefined) {
      problems.push(
        `${rel}: ${reach.reasons.join(', ')}, and has no row in check-tree-fs-table.ts`,
      );
    }
    if (reach.reasons.length === 0 && row !== undefined) {
      problems.push(`${rel}: has a row but no longer reaches a file; delete the row`);
    }
    if (rel !== CHECKED_IMPORTER && importsChecked(root, rel, reach.imports)) {
      problems.push(`${rel}: imports bound-path-checked.ts; only bound-path-guard.ts may`);
    }
    if (reach.namesInternals && rel !== INTERNALS_USER && rel !== INTERNALS_HOME) {
      problems.push(`${rel}: names treeInternals; only tree-fs-create.ts may`);
    }
  }
  for (const rel of Object.keys(table)) {
    if (!seen.has(rel)) problems.push(`${rel}: has a row but no such module`);
  }
  return problems;
}

/** The scanned modules of the repository at `root`, repo-relative. */
export function scannedFiles(root: string): string[] {
  const out: string[] = [];
  for (const dir of SCANNED) if (existsSync(join(root, dir))) walk(join(root, dir), out);
  return out.map((abs) => relative(root, abs).split(sep).join('/')).sort();
}

if (import.meta.main) {
  const problems = audit(REPO_ROOT, scannedFiles(REPO_ROOT), TREE_FS_TABLE);
  if (problems.length > 0) {
    console.error('check:tree-fs failed:');
    for (const p of problems) console.error(`  ${p}`);
    console.error('Each label is described in check-tree-fs-table.ts.');
    process.exit(1);
  }
  console.log(
    `✅ every module that reaches a file has a lead-tree row (${Object.keys(TREE_FS_TABLE).length})`,
  );
}
