/**
 * The infra scripts find their own files from `import.meta.url`. Prod's
 * checkout lives under `~/Library/Application Support/`, and a URL spells
 * that space `%20`: reading `.pathname` off it named a directory that does
 * not exist, so `machines.json` was ENOENT from there and nowhere else. This
 * copies the scripts into a directory whose name has a space and runs them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
let root = '';
let copy = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cw-space-'));
  copy = join(root, 'Application Support', 'repo');
  for (const path of ['infra', 'packages/server/src', 'packages/core']) {
    cpSync(join(REPO, path), join(copy, path), {
      recursive: true,
      filter: (src) => !src.includes('node_modules'),
    });
  }
  // The server's own node_modules links `@claude-workspaces/core` to `../../../core`,
  // which from the copy is the copied core.
  for (const dir of ['', 'packages/server']) {
    symlinkSync(join(REPO, dir, 'node_modules'), join(copy, dir, 'node_modules'));
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[]) {
  const proc = Bun.spawnSync(['bun', ...args], { cwd: copy, stdout: 'pipe', stderr: 'pipe' });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe('infra scripts in a directory whose name has a space', () => {
  it('reads machines.json', () => {
    const r = run(['infra/project-machine/machines.ts', 'matrix']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out.trim().length).toBeGreaterThan(0);
  });

  it('finds the terraform directory and the release key directory', () => {
    const r = run([
      '-e',
      [
        "const { existsSync } = await import('node:fs');",
        "const { dirname } = await import('node:path');",
        "const { TF_DIR } = await import('./infra/cloudflare/terraform.ts');",
        "const { BAKED_KEY } = await import('./infra/project-machine/release-cli.ts');",
        'console.log(JSON.stringify([TF_DIR, existsSync(TF_DIR), existsSync(dirname(BAKED_KEY))]));',
      ].join(''),
    ]);
    expect(r.code).toBe(0);
    const [dir, dirExists, keyExists] = JSON.parse(r.out) as [string, boolean, boolean];
    expect(dir).toContain('Application Support');
    expect([dirExists, keyExists]).toEqual([true, true]);
  });
});
