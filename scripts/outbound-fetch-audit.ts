#!/usr/bin/env bun
/**
 * The outbound-fetch gate: every request the server makes goes through
 * `packages/server/src/outbound-fetch.ts`.
 *
 * That module is where an address is checked before the server connects to it
 * — public addresses only, a fixed vendor or configured host, or a loopback
 * origin with a named purpose. A bare `fetch(` anywhere else is a request that
 * skipped the check, and the finding it reopens (security review H4: a planted
 * link reads a service on the Mac as the server) is silent until someone
 * plants one.
 *
 * What counts as bare is any VALUE reference to the global: a call
 * (`fetch(url)`), a default (`opts.fetch ?? fetch`, `get: typeof fetch =
 * fetch`), shorthand (`{ fetch }`), and the global's other spellings
 * (`globalThis.fetch`, `globalThis['fetch']`, `Bun.fetch`, `self.fetch`,
 * `window.fetch`). What does not: a property or method NAMED fetch
 * (`opts.fetch(...)`, `Bun.serve({ fetch })`, `async fetch(req)`) — that is an
 * injected function, and whoever injects it is checked at their own call — a
 * type (`typeof fetch` in a type position), and a local binding that shadows
 * the global. Text inside a string or template literal is not code: the pages
 * the server renders carry their own browser-side `fetch(` calls, and those
 * run in the reader's browser, not here.
 *
 * Parsed with the TypeScript compiler rather than matched with a regex, so a
 * comment, a string or a property name cannot trip it and a wrapped call
 * cannot slip past it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SRC_ROOT = posix.join('packages', 'server', 'src');
/** The one module allowed to touch the global fetch. */
export const GUARD = posix.join(SRC_ROOT, 'outbound-fetch.ts');

const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global', 'Bun']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

export interface Finding {
  file: string;
  line: number;
  text: string;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Does `scope` itself declare a binding named `fetch`? */
function declaresFetch(scope: ts.Node): boolean {
  const named = (n: ts.BindingName | undefined): boolean => {
    if (!n) return false;
    if (ts.isIdentifier(n)) return n.text === 'fetch';
    return n.elements.some((e) => !ts.isOmittedExpression(e) && named(e.name));
  };
  if (ts.isFunctionLike(scope)) {
    if (scope.parameters.some((p) => named(p.name))) return true;
    if (ts.isFunctionExpression(scope) && scope.name?.text === 'fetch') return true;
  }
  if (ts.isCatchClause(scope)) return named(scope.variableDeclaration?.name);
  const statements: readonly ts.Node[] =
    ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)
      ? scope.statements
      : ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)
        ? scope.initializer
          ? [scope.initializer]
          : []
        : [];
  for (const s of statements) {
    if (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => named(d.name))) {
      return true;
    }
    if (ts.isVariableDeclarationList(s) && s.declarations.some((d) => named(d.name))) return true;
    if (ts.isFunctionDeclaration(s) && s.name?.text === 'fetch') return true;
    if (ts.isImportDeclaration(s)) {
      const c = s.importClause;
      if (c?.name?.text === 'fetch') return true;
      const b = c?.namedBindings;
      if (b && ts.isNamedImports(b) && b.elements.some((e) => e.name.text === 'fetch')) return true;
    }
  }
  return false;
}

function shadowed(id: ts.Node): boolean {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (declaresFetch(n)) return true;
  }
  return false;
}

function inTypePosition(id: ts.Node): boolean {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (ts.isTypeNode(n)) return true;
    if (ts.isExpression(n) || ts.isStatement(n)) return false;
  }
  return false;
}

/** Is this identifier a name rather than a reference — `x.fetch`, `{ fetch: … }`, `fetch() {}`? */
function isNameSlot(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
  if (ts.isPropertyAssignment(p) && p.name === id) return true;
  if ((ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) && p.name === id) return true;
  if ((ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)) && p.name === id) return true;
  if ((ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.name === id) return true;
  if (ts.isBindingElement(p) && p.propertyName === id) return true;
  if (ts.isVariableDeclaration(p) && p.name === id) return true;
  if (ts.isParameter(p) && p.name === id) return true;
  if (ts.isBindingElement(p) && p.name === id) return true;
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === id) return true;
  return false;
}

/** Every reference to the global fetch in one file's source. */
export function findingsIn(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Finding[] = [];
  const report = (node: ts.Node): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ file, line: line + 1, text: (source.split('\n')[line] ?? '').trim() });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'fetch') {
      if (!isNameSlot(node) && !inTypePosition(node) && !shadowed(node)) report(node);
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'fetch' &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text) &&
      !inTypePosition(node)
    ) {
      report(node);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'fetch'
    ) {
      report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(abs, root, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(toPosix(relative(root, abs)));
    }
  }
  return out;
}

export function audit(root: string): Finding[] {
  const scanDir = join(root, ...SRC_ROOT.split('/'));
  try {
    if (!statSync(scanDir).isDirectory()) return [];
  } catch {
    return [];
  }
  const found: Finding[] = [];
  for (const rel of walk(scanDir, root)) {
    if (rel === GUARD) continue;
    found.push(...findingsIn(rel, readFileSync(join(root, ...rel.split('/')), 'utf8')));
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (import.meta.main) {
  const found = audit(REPO_ROOT);
  if (found.length === 0) {
    console.log(`outbound-fetch: every request in ${SRC_ROOT} goes through ${GUARD}`);
    process.exit(0);
  }
  console.error(`outbound-fetch: ${found.length} request(s) skip ${GUARD}:\n`);
  for (const f of found) console.error(`  ${f.file}:${f.line}  ${f.text}`);
  console.error(
    '\nUse publicFetch for an address that came from content or a person, ' +
      'fixedHostFetch for a vendor or configured host, or loopbackFetch with a ' +
      'named purpose for an origin on this machine.',
  );
  process.exit(1);
}
