/**
 * `asCw` (infra/project-machine/mac-ops.ts): a machine tool that calls the
 * board server's REST runs as `cw`, because the loopback uid door admits cw
 * alone (security review M3), and it runs with none of the secrets in the
 * `fly ssh console` shell that started it. A stand-in `setpriv` records what
 * it was handed and runs the command, so the command line is driven, not read.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asCw } from '../../../infra/project-machine/mac-ops.ts';

const bin = mkdtempSync(join(tmpdir(), 'as-cw-'));
const record = join(bin, 'setpriv.log');
writeFileSync(
  join(bin, 'setpriv'),
  `#!/bin/sh\n{ echo "argv $*"; env | sort; } > "${record}"\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
);
chmodSync(join(bin, 'setpriv'), 0o755);
afterAll(() => rmSync(bin, { recursive: true, force: true }));

const PATH = `${bin}:/usr/bin:/bin`;

function run(command: string) {
  return spawnSync('sh', ['-c', asCw(command, PATH)], {
    encoding: 'utf8',
    env: {
      PATH,
      CLOUDFLARE_TUNNEL_TOKEN: 'fixture-tunnel-riverbend',
      BACKUP_S3_SECRET_ACCESS_KEY: 'fixture-bucket-riverbend',
    },
  });
}

describe('asCw', () => {
  it('switches to cw and hands the command none of the shell’s secrets', () => {
    const r = run('echo "ran $HOME $CW_DATA_DIR"; env');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ran /home/cw /data/cw');
    const log = readFileSync(record, 'utf8');
    expect(log).toContain('argv --reuid=cw --regid=cw --init-groups --');
    for (const out of [r.stdout, log]) {
      expect(out).not.toContain('fixture-tunnel-riverbend');
      expect(out).not.toContain('fixture-bucket-riverbend');
    }
  });

  it('CONTROL: the same shell without asCw does hand the command its secrets', () => {
    const r = spawnSync('sh', ['-c', 'env'], {
      encoding: 'utf8',
      env: { PATH, CLOUDFLARE_TUNNEL_TOKEN: 'fixture-tunnel-riverbend' },
    });
    expect(r.stdout).toContain('fixture-tunnel-riverbend');
  });

  it('carries quotes in the command through', () => {
    expect(run("printf '%s' 'a b'").stdout).toBe('a b');
  });

  it('keeps the exit status of the command', () => {
    expect(run('exit 3').status).toBe(3);
  });
});
