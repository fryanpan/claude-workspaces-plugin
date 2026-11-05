/**
 * The lead-tree gate, on fixtures rather than this repo: each module shape
 * that reaches a file fails without a row and passes with one, and a module
 * that reaches nothing needs none, so a gate that flagged everything fails
 * as loudly as one that flagged nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { audit, reachOf, scannedFiles } from './check-tree-fs';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function repo(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'tree-fs-gate-'));
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), src);
  }
  return root;
}

const S = 'packages/server/src';

describe('reachOf', () => {
  it('sees each spelling of file and spawn access, and not a comment or a string', () => {
    expect(reachOf('a.ts', "import { readFileSync } from 'node:fs';").reasons).toEqual([
      'imports node:fs',
    ]);
    expect(reachOf('a.ts', "const fs = await import('fs');").reasons).toEqual(['imports fs']);
    expect(reachOf('a.ts', "const cp = require('child_process');").reasons).toEqual([
      'imports child_process',
    ]);
    expect(reachOf('a.ts', 'Bun.spawn(["git"]);').reasons).toEqual(['uses Bun.spawn']);
    expect(reachOf('a.ts', 'const x = readLine(p, /x/);').reasons).toEqual(['calls readLine']);
    expect(
      reachOf('a.ts', "import { replaceFile } from '@claude-workspaces/core/safe-file';").reasons,
    ).toEqual(['imports safe-file']);
    expect(
      reachOf('a.ts', "// import 'node:fs'\nconst s = \"readFileSync('fs')\";").reasons,
    ).toEqual([]);
  });
});

describe('audit', () => {
  const files = {
    [`${S}/reads.ts`]: "import { readFileSync } from 'node:fs';\nexport const a = readFileSync;\n",
    [`${S}/helper.ts`]: "import { readLine } from './git-hardening.ts';\nreadLine('/x', /y/);\n",
    [`${S}/dynamic.ts`]: "export const f = () => import('fs');\n",
    'packages/core/src/core-io.ts':
      "import { writeFileSync } from 'fs';\nexport { writeFileSync };\n",
    [`${S}/pure.ts`]: 'export const two = 1 + 1;\n',
  };

  it('fails each reaching module with no row, and passes once each has one', () => {
    const r = repo(files);
    const listed = scannedFiles(r);
    const problems = audit(r, listed, {});
    expect(problems).toHaveLength(4);
    for (const name of ['reads.ts', 'helper.ts', 'dynamic.ts', 'core-io.ts'])
      expect(problems.some((p) => p.includes(name))).toBe(true);
    expect(problems.some((p) => p.includes('pure.ts'))).toBe(false);
    const table = {
      [`${S}/reads.ts`]: 'tree-fs',
      [`${S}/helper.ts`]: 'refused-when-covered',
      [`${S}/dynamic.ts`]: 'data-dir',
      'packages/core/src/core-io.ts': 'owner-checkout',
    };
    expect(audit(r, listed, table)).toEqual([]);
  });

  it('fails a row for a module that reaches nothing, or is gone', () => {
    const r = repo(files);
    const table = {
      [`${S}/reads.ts`]: 'tree-fs',
      [`${S}/helper.ts`]: 'tree-fs',
      [`${S}/dynamic.ts`]: 'tree-fs',
      'packages/core/src/core-io.ts': 'tree-fs',
      [`${S}/pure.ts`]: 'tree-fs',
      [`${S}/gone.ts`]: 'tree-fs',
    };
    const problems = audit(r, scannedFiles(r), table);
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.includes('pure.ts'))).toBe(true);
    expect(problems.some((p) => p.includes('gone.ts'))).toBe(true);
  });

  it('lets only bound-path-guard import bound-path-checked, and only tree-fs-create name treeInternals', () => {
    const r = repo({
      [`${S}/bound-path-checked.ts`]:
        "import { open } from 'node:fs/promises';\nexport { open };\n",
      [`${S}/bound-path-guard.ts`]: "export { open } from './bound-path-checked.ts';\n",
      [`${S}/sneaky.ts`]: "export { open } from './bound-path-checked.ts';\n",
      [`${S}/tree-fs-create.ts`]:
        "import { treeInternals } from './tree-fs.ts';\nexport const t = treeInternals;\n",
      [`${S}/other.ts`]:
        "import { treeInternals } from './tree-fs.ts';\nexport const t = treeInternals;\n",
    });
    const problems = audit(r, scannedFiles(r), { [`${S}/bound-path-checked.ts`]: 'tree-fs' });
    expect(problems).toEqual([
      `${S}/other.ts: names treeInternals; only tree-fs-create.ts may`,
      `${S}/sneaky.ts: imports bound-path-checked.ts; only bound-path-guard.ts may`,
    ]);
  });
});
