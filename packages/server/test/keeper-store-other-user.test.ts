/**
 * Another macOS (or Linux) user cannot read the keeper's store.
 *
 * The store is written by this process's user, standing in for the keeper's,
 * and then read as `nobody`, standing in for an agent's user. Running as
 * another user takes `sudo`, which only CI may use without a password, so
 * the suite runs only where `CW_KEEPER_SUDO_TESTS=1` is set (ci.yml's server
 * step) and is skipped everywhere else, saying so.
 *
 * The CONTROL is a file `nobody` may read, read the same way: it proves the
 * `sudo -u nobody` read works, so the refusal below is the store's modes and
 * not a broken probe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openKeeperStore } from '../src/keeper/keeper-store.ts';

const ENABLED = process.env.CW_KEEPER_SUDO_TESTS === '1';
if (!ENABLED)
  console.error('[keeper] other-user store test skipped: CW_KEEPER_SUDO_TESTS is not 1');

const asNobody = (args: string[]) =>
  spawnSync('sudo', ['-n', '-u', 'nobody', ...args], { encoding: 'utf8', timeout: 10_000 });

describe.skipIf(!ENABLED)("an agent's user reading the keeper's store", () => {
  // Under /tmp, whose every parent another user can traverse, so the only
  // thing standing between `nobody` and the file is the store's own mode.
  const root = ENABLED ? mkdtempSync('/tmp/keeper-other-user-') : '';
  const store = join(root, 'store');
  const open = join(root, 'open');
  const secret = `test-fly-${crypto.randomUUID()}`;

  beforeAll(() => {
    chmodSync(root, 0o755);
    mkdirSync(store, { mode: 0o700 });
    const s = openKeeperStore(store);
    if ('error' in s) throw new Error(s.error);
    s.setCredential('fly-org-token', secret);
    mkdirSync(open, { mode: 0o755 });
    writeFileSync(join(open, 'readable.txt'), 'readable by anyone', { mode: 0o644 });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('CONTROL: nobody reads a file that is open to it', () => {
    const r = asNobody(['cat', join(open, 'readable.txt')]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('readable by anyone');
  });

  it('nobody cannot read the credentials, list the store, or read it by its file name', () => {
    const read = asNobody(['cat', join(store, 'credentials.json')]);
    expect(read.status).not.toBe(0);
    expect(read.stderr).toContain('Permission denied');
    expect(read.stdout).not.toContain(secret);
    const list = asNobody(['ls', store]);
    expect(list.status).not.toBe(0);
    expect(list.stderr).toContain('Permission denied');
  });
});
