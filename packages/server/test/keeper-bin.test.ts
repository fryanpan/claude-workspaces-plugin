/**
 * The keeper's process, run as a child: a credential arrives on stdin and
 * never on the command line or in the output; and the keeper will not start
 * with a `fly` another user could replace, or with a store others can open.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = join(import.meta.dir, '../src/keeper/keeper-bin.ts');
const tmp = mkdtempSync(join(tmpdir(), 'keeper-bin-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function keeper(args: string[], env: Record<string, string>, input = '') {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: tmp, ...env },
    timeout: 20_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function storeDir(name: string, mode: number): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, mode);
  return dir;
}

describe('keeper-bin', () => {
  it('imports a credential from stdin into a mode-600 file and never prints it', () => {
    const dir = storeDir('store', 0o700);
    const value = `test-cf-${crypto.randomUUID()}`;
    const r = keeper(['import', 'cloudflare-api-token'], { CW_KEEPER_DIR: dir }, `${value}\n`);
    // The guard may refuse on a machine whose bun sits somewhere others can
    // write; then nothing may have been stored either.
    if (r.status !== 0) {
      expect(r.out).toContain('unsafe:');
      return;
    }
    expect(r.out).toContain('stored cloudflare-api-token');
    expect(r.out).not.toContain(value);
    const file = join(dir, 'credentials.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).cloudflare.apiToken).toBe(value);
  });

  it('refuses an unknown credential name', () => {
    const r = keeper(['import', 'gh-token'], { CW_KEEPER_DIR: storeDir('names', 0o700) }, 'x');
    expect(r.status).toBe(1);
  });

  it('will not start with a fly another user could replace', () => {
    const open = join(tmp, 'shared-bin');
    mkdirSync(open);
    chmodSync(open, 0o777);
    const fly = join(open, 'fly');
    writeFileSync(fly, '#!/bin/sh\n', { mode: 0o755 });
    const r = keeper([], {
      CW_KEEPER_DIR: storeDir('run', 0o700),
      CW_KEEPER_FLY_BIN: fly,
      CW_KEEPER_PORT: '1',
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`unsafe: ${realpathSync(open)} is writable by group or others`);
    expect(r.out).toContain('refusing to start');
  });

  it('port chooses the port once, and the plists and the enroll link use it', () => {
    const env = { CW_KEEPER_DIR: storeDir('port', 0o700) };
    const r = keeper(['port'], env);
    if (r.status !== 0) {
      expect(r.out).toContain('unsafe:');
      return;
    }
    const port = Number(r.out.trim());
    expect(port).toBeGreaterThanOrEqual(20000);
    expect(keeper(['port'], env).out.trim()).toBe(String(port));
    expect(keeper(['plist', 'port'], env).out).toContain(`<string>${port}</string>`);
    expect(keeper(['plist', 'keeper'], env).out).toContain(`<string>${port}</string>`);
    expect(keeper(['enroll'], env).out).toContain(`http://localhost:${port}/enroll/`);
  });

  it('check names a store others can open', () => {
    const r = keeper(['check'], { CW_KEEPER_DIR: storeDir('loose', 0o755) });
    expect(r.status).toBe(1);
    expect(r.out).toContain('only its owner may open it');
  });
});
