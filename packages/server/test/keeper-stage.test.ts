import { afterAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageFlyPaths } from '../src/keeper/keeper-stage.ts';

const me = process.getuid?.() ?? -1;
/** A user id nobody here has: the keeper, when the files are this process's. */
const OTHER = 4_000_000;
const tmp = mkdtempSync(join(tmpdir(), 'keeper-stage-test-'));
const ctx = join(tmp, 'ctx');
mkdirSync(join(ctx, 'infra'), { recursive: true });
writeFileSync(join(ctx, 'Dockerfile'), 'FROM scratch\n');
writeFileSync(join(ctx, 'infra', 'fly.toml'), 'app = "cw-harborlight"\n');
symlinkSync('/etc/hosts', join(ctx, 'hosts-link'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('stageFlyPaths', () => {
  it('copies each path, links as links, and points the argv at the copies', () => {
    const args = ['deploy', ctx, `--config=${join(ctx, 'infra', 'fly.toml')}`, '--app', 'x'];
    const staged = stageFlyPaths(args, [2, 1], OTHER, tmp);
    const [, copy = '', config = ''] = staged.args;
    expect(copy).not.toBe(ctx);
    expect(readFileSync(join(copy, 'Dockerfile'), 'utf8')).toBe('FROM scratch\n');
    // A file inside the build folder is the folder copy's own.
    expect(config).toBe(`--config=${join(copy, 'infra', 'fly.toml')}`);
    expect(readFileSync(join(copy, 'infra', 'fly.toml'), 'utf8')).toContain('cw-harborlight');
    expect(readlinkSync(join(copy, 'hosts-link'))).toBe('/etc/hosts');
    expect(staged.args.slice(3)).toEqual(['--app', 'x']);
    staged.done();
    expect(existsSync(copy)).toBe(false);
  });

  it('refuses a named file that is a link, inside the folder or not', () => {
    for (const args of [
      ['deploy', ctx, '--dockerfile', join(ctx, 'hosts-link')],
      ['deploy', ctx, '--config', join(tmp, 'outside-link')],
    ]) {
      symlinkSync('/etc/hosts', join(tmp, 'outside-link'));
      expect(() => stageFlyPaths(args, [3, 1], OTHER, tmp)).toThrow('not a plain file');
      rmSync(join(tmp, 'outside-link'));
    }
  });

  it("refuses a file that belongs to the keeper's user, and leaves no copy", () => {
    // Here this process's files stand in for the keeper's store.
    const before = new Set(readdirSync(tmp));
    expect(() => stageFlyPaths(['deploy', ctx], [1], me, tmp)).toThrow('belongs to the keeper');
    expect(new Set(readdirSync(tmp))).toEqual(before);
  });
});
