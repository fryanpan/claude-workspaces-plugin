import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Drives the two functions install-triage.sh sources — bun resolution and the
 * template fill — over the real doc-triage template, and parses the result
 * with Python's plistlib so each key reads the way launchd reads it.
 * install-triage.sh itself is not run: it boots the job in the real launchd
 * domain.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'render-triage-plist.sh');
const TEMPLATE = join(HERE, 'com.fryanpan.doc-triage.plist.template');

type Plist = Record<string, unknown> & { EnvironmentVariables: Record<string, string> };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'render-triage-plist-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A directory holding an executable `bun` that does nothing. */
function fakeBunDir(under: string): string {
  const bin = join(under, 'bin');
  mkdirSync(bin, { recursive: true });
  const bun = join(bin, 'bun');
  writeFileSync(bun, '#!/bin/sh\nexit 0\n');
  chmodSync(bun, 0o755);
  return bin;
}

function resolve(path: string, home: string) {
  return spawnSync('/bin/bash', ['-c', '. "$LIB"; resolve_bun_bin'], {
    env: { PATH: path, HOME: home, LIB },
    encoding: 'utf8',
  });
}

function render(bunDir: string): Plist {
  const out = join(dir, 'out.plist');
  execFileSync(
    '/bin/bash',
    ['-c', 'set -euo pipefail; . "$LIB"; render_triage_plist "$TEMPLATE" > "$OUT"'],
    {
      env: {
        PATH: '/usr/bin:/bin',
        LIB,
        TEMPLATE,
        OUT: out,
        HOME: '/synthetic/home',
        REPO_DIR: '/synthetic/repo',
        CLAUDE_BIN: '/synthetic/claude/bin/claude',
        CLAUDE_DIR: '/synthetic/claude/bin',
        BUN_DIR: bunDir,
        LOG_DIR: '/synthetic/logs',
      },
    },
  );
  const json = execFileSync(
    'python3',
    [
      '-I',
      '-c',
      'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))',
      out,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(json) as Plist;
}

describe('resolve_bun_bin', () => {
  it('prefers ~/.bun/bin/bun over PATH, as install.sh does', () => {
    const onPath = fakeBunDir(join(dir, 'harborlight'));
    const home = join(dir, 'home');
    const bunDir = fakeBunDir(join(home, '.bun'));
    const r = resolve(`${onPath}:/usr/bin:/bin`, home);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(join(bunDir, 'bun'));
  });

  it('falls back to PATH when ~/.bun/bin has none', () => {
    const onPath = fakeBunDir(join(dir, 'harborlight'));
    const r = resolve(`${onPath}:/usr/bin:/bin`, join(dir, 'empty-home'));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(join(onPath, 'bun'));
  });

  it('fails loudly when bun is nowhere', () => {
    const r = resolve('/usr/bin:/bin', join(dir, 'empty-home'));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('bun not found');
  });
});

describe('render_triage_plist on the doc-triage template', () => {
  it('fills every placeholder', () => {
    const plist = render('/synthetic/bun/bin');
    expect(JSON.stringify(plist)).not.toContain('{{');
    expect(plist.WorkingDirectory).toBe('/synthetic/repo');
    expect(plist.EnvironmentVariables.CLAUDE_BIN).toBe('/synthetic/claude/bin/claude');
  });

  it("puts bun's directory on the job's PATH, so the run's MCP servers can start", () => {
    const home = join(dir, 'home');
    const resolved = resolve('/usr/bin:/bin', home);
    // Positive control for the fallback path: nothing is installed yet.
    expect(resolved.status).not.toBe(0);
    const bunDir = fakeBunDir(join(home, '.bun'));
    const bunBin = resolve('/usr/bin:/bin', home).stdout.trim();
    const plist = render(dirname(bunBin));
    const path = plist.EnvironmentVariables.PATH ?? '';
    expect(path.split(':')).toContain(bunDir);
    // And a shell given exactly that PATH finds bun, the way launchd's child would.
    const found = spawnSync('/bin/sh', ['-c', 'command -v bun'], {
      env: { PATH: path },
      encoding: 'utf8',
    });
    expect(found.stdout.trim()).toBe(join(bunDir, 'bun'));
  });
});
