/**
 * The machine probe picks the board server by its user and parent, and sees
 * Remote Control past the one flag (24 Nov wall re-review, L4). The
 * processes are stand-ins; nothing reads a real /proc.
 */
import { describe, expect, it } from 'bun:test';
import {
  type FactsIo,
  type Proc,
  readFacts,
  statusIds,
} from '../../../infra/project-machine/machine-facts.ts';

describe('L4: the probe finds the server by user and parent, and Remote Control past flags', () => {
  const PASSWD =
    'root:x:0:0::/root:/bin/sh\ncw:x:10001:10001::/home/cw:/bin/sh\nlead:x:10004:10004::/home/lead:/bin/sh\n';
  const proc = (
    pid: number,
    ppid: number,
    uid: number,
    cmdline: string[],
    env: Record<string, string> = {},
  ): Proc => ({ pid, ppid, uid, cmdline, environ: () => env });
  const tini = proc(1, 0, 0, ['/usr/bin/tini', '-s', '--', '/app/entrypoint.sh']);
  const supervisor = proc(7, 1, 0, ['bash', '/app/infra/project-machine/entrypoint.sh']);
  // A root subshell of the supervisor: same command line, a different parent.
  const subshell = proc(9, 7, 0, ['bash', '/app/infra/project-machine/entrypoint.sh']);
  const BIN = ['bun', 'run', '/app/packages/server/src/bin.ts'];
  const io = (procs: Proc[], leadEnv: Record<string, string> = {}): FactsIo => ({
    procs: () => procs,
    read: (p) => (p === '/etc/passwd' ? PASSWD : null),
    leadEnv: () => leadEnv,
    dirs: () => [],
    publicKey: () => null,
  });

  it('ignores a process that names bin.ts but is not cw under the root supervisor', () => {
    const decoy = proc(40, 30, 10004, BIN, { CW_OWNER_EMAIL: 'bob@example.com' });
    const uploader = proc(41, 9, 10001, BIN, { CW_OWNER_EMAIL: 'bob@example.com' });
    const server = proc(20, 7, 10001, BIN, { CW_OWNER_EMAIL: 'alice@example.com' });
    expect(readFacts(io([tini, supervisor, subshell, decoy, uploader, server])).server).toEqual({
      CW_OWNER_EMAIL: 'alice@example.com',
    });
    expect(readFacts(io([tini, supervisor, subshell, decoy, uploader])).server).toBeNull();
  });

  it('sees Remote Control from the subcommand, --rc, or a bridged session’s environment', () => {
    const on = (p: Proc) => readFacts(io([tini, supervisor, p])).lead?.remoteControl;
    expect(on(proc(50, 7, 10004, ['claude', 'remote-control']))).toBe(true);
    expect(on(proc(50, 7, 10004, ['claude', '--rc']))).toBe(true);
    expect(
      on(proc(50, 7, 10004, ['bash'], { CLAUDE_CODE_BRIDGE_SESSION_ID: 'fixture-session' })),
    ).toBe(true);
    expect(on(proc(50, 7, 10004, ['claude', '--continue']))).toBe(false);
    // Another user's environment is not the lead's.
    expect(
      on(proc(50, 7, 10001, ['bash'], { CLAUDE_CODE_BRIDGE_SESSION_ID: 'fixture-session' })),
    ).toBe(false);
  });
});

describe('the probe reads ids out of /proc/<pid>/status', () => {
  it('takes the parent pid and the real uid, and NaN for a field it lacks', () => {
    const status = 'Name:\tbun\nPid:\t20\nPPid:\t7\nUid:\t10001\t10001\t10001\t10001\n';
    expect(statusIds(status)).toEqual({ ppid: 7, uid: 10001 });
    expect(statusIds('Name:\tbun\n')).toEqual({ ppid: Number.NaN, uid: Number.NaN });
  });
});
