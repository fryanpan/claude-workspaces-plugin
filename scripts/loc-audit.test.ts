import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DRIFT_LIMIT,
  LINE_LIMIT,
  audit,
  countLines,
  isScannable,
  listedPaths,
  rowCounts,
} from './loc-audit';

const dirs: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'loc-audit-'));
  dirs.push(root);
  mkdirSync(join(root, 'packages', 'demo', 'src'), { recursive: true });
  mkdirSync(join(root, 'docs', 'architecture'), { recursive: true });
  return root;
}

function writeLines(root: string, rel: string, lines: number): void {
  writeFileSync(join(root, rel), `${'x\n'.repeat(lines)}`);
}

function writeDoc(root: string, body: string): void {
  writeFileSync(join(root, 'docs', 'architecture', 'exceptions.md'), body);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('countLines', () => {
  it('counts newlines the way wc -l does, so the doc and the gate agree', () => {
    expect(countLines('a\nb\nc\n')).toBe(3);
    // No trailing newline: wc -l reports 2 here too.
    expect(countLines('a\nb\nc')).toBe(2);
    expect(countLines('')).toBe(0);
  });
});

describe('isScannable', () => {
  it('takes .ts, .tsx, .mjs and .css under packages', () => {
    expect(isScannable('packages/demo/src/a.ts')).toBe(true);
    expect(isScannable('packages/demo/src/a.tsx')).toBe(true);
    expect(isScannable('packages/demo/src/a.mjs')).toBe(true);
    expect(isScannable('packages/demo/src/a.css')).toBe(true);
  });

  it('skips generated and vendored trees, and the committed MCP bundle', () => {
    expect(isScannable('packages/demo/node_modules/big/index.ts')).toBe(false);
    expect(isScannable('packages/demo/dist/bundle.ts')).toBe(false);
    expect(isScannable('packages/plugin/mcp/index.js')).toBe(false);
  });

  it('skips file types the bar does not cover', () => {
    expect(isScannable('packages/demo/src/README.md')).toBe(false);
    expect(isScannable('packages/demo/src/data.json')).toBe(false);
  });
});

describe('listedPaths', () => {
  it('reads paths out of table cells and prose alike', () => {
    const found = listedPaths(
      '| `packages/a/src/one.ts` | 900 | Split | move it to `two.ts` |\nsee packages/b/src/style.css too\n',
    );
    expect([...found].sort()).toEqual(['packages/a/src/one.ts', 'packages/b/src/style.css']);
  });

  it('reads a .tsx path whole rather than stopping at .ts', () => {
    const found = listedPaths(
      '| `packages/a/src/island.tsx` | 600 | Keep | x |\npackages/b/plot.mjs',
    );
    expect([...found].sort()).toEqual(['packages/a/src/island.tsx', 'packages/b/plot.mjs']);
  });

  it('does not count a proposed new filename as a listed file', () => {
    // Reasons name new files by bare name; only `packages/`-rooted paths count,
    // so a seam proposal can never accidentally satisfy the gate.
    expect([...listedPaths('split into `task-goals.ts` and `task-agents.ts`')]).toEqual([]);
  });
});

describe('audit', () => {
  it('passes when every oversized file has a row', () => {
    const root = fixture();
    writeLines(root, 'packages/demo/src/big.ts', LINE_LIMIT + 1);
    writeLines(root, 'packages/demo/src/small.ts', LINE_LIMIT - 1);
    writeDoc(root, '| `packages/demo/src/big.ts` | 501 | Exception | one job |');

    const result = audit(root);
    expect(result.total).toBe(1);
    expect(result.unlisted).toEqual([]);
  });

  it('reports an oversized file that git has never heard of', () => {
    // A regression guard, not a bug fix. `test-audit` enumerated with
    // `git ls-files` and was therefore blind to the untracked test files it
    // exists to judge; `loc-audit` walks the tree with readdir and is not, so
    // it needed no change. This pins that difference: the fixture is a real
    // git repo where the oversized file is untracked, so a future switch to
    // any git-based enumeration turns this red instead of quietly shipping
    // the same blind spot.
    const root = fixture();
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    writeLines(root, 'packages/demo/src/committed.ts', 900);
    git('add', '-A');
    git('-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-qm', 'fixture');
    writeLines(root, 'packages/demo/src/never-staged.ts', 900);
    writeDoc(root, 'nothing listed here');

    // Positive control in the same run: the committed file is seen too, so a
    // green result cannot come from the audit having found nothing at all.
    const unlisted = audit(root).unlisted.map((o) => o.path);
    expect(unlisted).toContain('packages/demo/src/committed.ts');
    expect(unlisted).toContain('packages/demo/src/never-staged.ts');
  });

  it('reports oversized .tsx and .mjs files with no row', () => {
    const root = fixture();
    writeLines(root, 'packages/demo/src/island.tsx', 700);
    writeLines(root, 'packages/demo/src/plot.mjs', 600);
    // A row for the .ts twin must not satisfy the .tsx file.
    writeDoc(root, '| `packages/demo/src/island.ts` | 700 | Keep | wrong file |');

    expect(audit(root).unlisted.map((o) => o.path)).toEqual([
      'packages/demo/src/island.tsx',
      'packages/demo/src/plot.mjs',
    ]);
  });

  it('reports an oversized file with no row', () => {
    const root = fixture();
    writeLines(root, 'packages/demo/src/big.ts', 900);
    writeDoc(root, 'nothing listed here');

    expect(audit(root).unlisted).toEqual([{ path: 'packages/demo/src/big.ts', lines: 900 }]);
  });

  it('treats exactly 500 lines as under the limit', () => {
    const root = fixture();
    writeLines(root, 'packages/demo/src/edge.ts', LINE_LIMIT);
    writeDoc(root, 'nothing listed here');

    expect(audit(root).total).toBe(0);
  });

  it('names a row whose file is gone or has shrunk as stale, without failing', () => {
    const root = fixture();
    writeLines(root, 'packages/demo/src/shrunk.ts', 100);
    writeDoc(root, '| `packages/demo/src/shrunk.ts` | 900 | Split | already done |');

    const result = audit(root);
    expect(result.unlisted).toEqual([]);
    expect(result.stale).toEqual(['packages/demo/src/shrunk.ts']);
  });

  it('reads each row’s Lines cell, commas and all, and ignores prose', () => {
    const counts = rowCounts(
      '| `packages/a/src/one.ts` | 1,200 | Keep | x |\n| `packages/a/src/two.tsx` | 600 | Exception | y |\nsee `packages/a/src/three.ts` | 9 |',
    );
    expect([...counts]).toEqual([
      ['packages/a/src/one.ts', 1200],
      ['packages/a/src/two.tsx', 600],
    ]);
  });

  it('fails a row whose count is more than the drift limit off, and only that row', () => {
    const root = fixture();
    const listed = 1000;
    const over = Math.floor(listed * (1 + DRIFT_LIMIT)) + 1;
    const within = Math.floor(listed * (1 + DRIFT_LIMIT));
    writeLines(root, 'packages/demo/src/grown.ts', over);
    writeLines(root, 'packages/demo/src/close.ts', within);
    writeDoc(
      root,
      `| \`packages/demo/src/grown.ts\` | ${listed} | Keep | x |\n| \`packages/demo/src/close.ts\` | ${listed} | Keep | y |`,
    );

    const result = audit(root);
    expect(result.unlisted).toEqual([]);
    expect(result.drifted).toEqual([{ path: 'packages/demo/src/grown.ts', lines: over, listed }]);
  });

  it('refuses to pass when the exceptions doc is missing', () => {
    const root = fixture();
    writeLines(root, 'packages/demo/src/big.ts', 900);
    expect(() => audit(root)).toThrow(/exceptions\.md is missing/);
  });
});
