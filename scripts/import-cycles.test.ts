/**
 * The import-cycle gate, exercised on fixtures rather than on this repo.
 *
 * A test that asserted "packages/core/src has no cycles" would go green the
 * day the tree went green and could never tell you the CHECK still works —
 * which is the failure mode that let PR 817 through sixteen green gates. So
 * every case here builds a tiny tree with a known answer, and every positive
 * has its negative twin: the same modules wired so they do NOT close a loop.
 *
 * The type-only cases carry the most weight. They are the reason this gate
 * ships at zero instead of with a baseline of exceptions, so a change that
 * made type-only edges count again would silently reintroduce six findings
 * that do not exist in any bundle.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { audit, findCycles, runtimeSpecifiers } from './import-cycles';

const dirs: string[] = [];

/** A repo root with `packages/pkg/src` populated from `files`. Returns the
 *  root and the source root's repo-relative path, which is what `audit` takes. */
function fixture(files: Record<string, string>): { root: string; srcRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'import-cycles-'));
  dirs.push(root);
  const srcRoot = 'packages/pkg/src';
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, srcRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return { root, srcRoot };
}

/** Cycles as sorted member sets, so an assertion does not depend on which
 *  node the walk happened to enter the loop from. */
function cycleSets(root: string, srcRoot: string): string[][] {
  return audit(root, [srcRoot])
    .map((c) => [...new Set(c)].map((f) => f.replace(`${srcRoot}/`, '')).sort())
    .sort((a, b) => a.join().localeCompare(b.join()));
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('runtimeSpecifiers', () => {
  it('keeps value imports and drops type-only ones', () => {
    const source = [
      "import { a } from './value.ts';",
      "import type { T } from './type-default.ts';",
      "import { type A, type B } from './type-braced.ts';",
      "import { type A, b } from './mixed.ts';",
      "import * as NS from './namespace.ts';",
      "import Def from './default.ts';",
      "import './side-effect.ts';",
      "export type { T } from './reexport-type.ts';",
      "export { v } from './reexport-value.ts';",
      "const m = await import('./dynamic.ts');",
      "import { far } from '@pkg/elsewhere';",
    ].join('\n');
    expect(runtimeSpecifiers(source).sort()).toEqual(
      [
        './default.ts',
        './dynamic.ts',
        './mixed.ts',
        './namespace.ts',
        './reexport-value.ts',
        './side-effect.ts',
        './value.ts',
      ].sort(),
    );
  });

  it('reads a braced clause the formatter has wrapped across lines', () => {
    // biome puts a long import on several lines, and the first version of the
    // scanner was line-oriented. A wrapped type-only clause read as runtime
    // and a wrapped value clause read as nothing at all.
    const typeOnly = "import {\n  type Alpha,\n  type Beta,\n} from './t.ts';";
    const value = "import {\n  alpha,\n  type Beta,\n} from './v.ts';";
    expect(runtimeSpecifiers(typeOnly)).toEqual([]);
    expect(runtimeSpecifiers(value)).toEqual(['./v.ts']);
  });
});

describe('findCycles', () => {
  it('reports a loop once however many nodes it is entered from', () => {
    const graph = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);
    const cycles = findCycles(graph);
    expect(cycles).toHaveLength(1);
    expect([...new Set(cycles[0])].sort()).toEqual(['a', 'b', 'c']);
  });

  it('finds nothing in a graph that only points downhill', () => {
    const graph = new Map([
      ['a', ['b', 'c']],
      ['b', ['c']],
      ['c', []],
    ]);
    expect(findCycles(graph)).toEqual([]);
  });

  it('separates two independent loops', () => {
    const graph = new Map([
      ['a', ['b']],
      ['b', ['a']],
      ['c', ['d']],
      ['d', ['c']],
      ['e', ['a', 'c']],
    ]);
    expect(findCycles(graph)).toHaveLength(2);
  });
});

describe('audit over a source tree', () => {
  it('catches the barrel loop that shipped: leaf imports a VALUE back out of the barrel', () => {
    // The exact shape of PR 817 (prose.ts → prose-batch.ts → suggest-ops.ts →
    // prose.ts) and of anchor/element.ts, reduced to two modules.
    const { root, srcRoot } = fixture({
      'barrel.ts': "export * from './leaf.ts';\nexport const THRESHOLD = 40;\n",
      'leaf.ts': "import { THRESHOLD } from './barrel.ts';\nexport const v = THRESHOLD;\n",
    });
    expect(cycleSets(root, srcRoot)).toEqual([['barrel.ts', 'leaf.ts']]);
  });

  it('passes the same two modules once the value lives in the leaf', () => {
    // The negative twin: identical file count, identical barrel, and the fix
    // this repo applied. A check that flagged every barrel would fail here.
    const { root, srcRoot } = fixture({
      'barrel.ts': "export * from './leaf.ts';\nexport { THRESHOLD } from './leaf.ts';\n",
      'leaf.ts': 'export const THRESHOLD = 40;\nexport const v = THRESHOLD;\n',
    });
    expect(cycleSets(root, srcRoot)).toEqual([]);
  });

  it('ignores a loop closed only by an erased type import', () => {
    // Both directions exist in the source and neither exists in the bundle.
    const { root, srcRoot } = fixture({
      'a.ts': "import type { B } from './b.ts';\nexport type A = B | null;\n",
      'b.ts': "import { mk } from './c.ts';\nexport type B = ReturnType<typeof mk>;\n",
      'c.ts': "import type { A } from './a.ts';\nexport const mk = (): A => null;\n",
    });
    expect(cycleSets(root, srcRoot)).toEqual([]);
  });

  it('catches the same three modules when one edge carries a value', () => {
    // The control for the case above: change ONE `import type` to a value
    // import and the loop must appear. Without this, the type-only exclusion
    // could be swallowing real findings and the test above would not know.
    const { root, srcRoot } = fixture({
      'a.ts': "import { b } from './b.ts';\nexport const a = b;\n",
      'b.ts': "import { mk } from './c.ts';\nexport const b = mk();\n",
      'c.ts': "import { a } from './a.ts';\nexport const mk = () => a;\n",
    });
    expect(cycleSets(root, srcRoot)).toEqual([['a.ts', 'b.ts', 'c.ts']]);
  });

  it('does not count a module importing itself, nor an edge that leaves the tree', () => {
    const { root, srcRoot } = fixture({
      'self.ts': "import { x } from './self.ts';\nexport const x = 1;\n",
      'out.ts': "import { y } from '@claude-workspaces/core';\nexport const z = y;\n",
    });
    expect(cycleSets(root, srcRoot)).toEqual([]);
  });

  it('answers empty for a source root that is not there', () => {
    const { root } = fixture({ 'a.ts': 'export const a = 1;\n' });
    expect(audit(root, ['packages/gone/src'])).toEqual([]);
  });

  it('skips test files, whose fixtures are not shipped code', () => {
    const { root, srcRoot } = fixture({
      'a.ts': 'export const a = 1;\n',
      'a.test.ts':
        "import { a } from './a.ts';\nimport { b } from './b.test.ts';\nexport const c = a + b;\n",
      'b.test.ts': "import { c } from './a.test.ts';\nexport const b = c;\n",
    });
    expect(cycleSets(root, srcRoot)).toEqual([]);
  });
});
