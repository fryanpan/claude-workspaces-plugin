/**
 * The lead's memory watchdog (`infra/project-machine/lead-memory.sh`), which
 * caps the lead where the machine has no cgroup v2 memory controller.
 *
 * It reads /proc, so this gives it a folder shaped like one
 * (`CW_MACHINE_PROC_ROOT`), with processes of the lead's uid and of others,
 * and a kill command that records what it was asked to kill
 * (`CW_LEAD_MEMORY_KILL`), so no real process is ever signalled. The limits
 * are kilobytes. That a real kernel's /proc reads the same, and that the
 * kill lands, is `project-machine-lead-limits-container.test.ts`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASH, machineDir } from './project-machine-harness.ts';
import { waitFor } from './wait-for.ts';

const script = join(machineDir, 'lead-memory.sh');
const LEAD = '10004';
const scratch = mkdtempSync(join(tmpdir(), 'lead-memory-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface FakeProc {
  pid: number;
  uid: string;
  euid?: string;
  rssKb?: number;
  pssKb?: number;
}

function fakeProc(procs: FakeProc[]): string {
  const root = mkdtempSync(join(scratch, 'proc-'));
  for (const p of procs) {
    const d = join(root, String(p.pid));
    mkdirSync(d);
    const status = ['Name:\tfixture', `Uid:\t${p.uid}\t${p.euid ?? p.uid}\t${p.uid}\t${p.uid}`];
    if (p.rssKb !== undefined) status.push(`VmRSS:\t   ${p.rssKb} kB`);
    writeFileSync(join(d, 'status'), `${status.join('\n')}\n`);
    if (p.pssKb !== undefined) {
      writeFileSync(join(d, 'smaps_rollup'), `Rss:   ${p.rssKb ?? 0} kB\nPss:   ${p.pssKb} kB\n`);
    }
  }
  // Not a process: the watchdog only reads numbered folders.
  mkdirSync(join(root, 'sys'));
  return root;
}

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(BASH as string, [script, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', ...env },
  });

describe.skipIf(BASH === null)('the lead memory watchdog', () => {
  it('reads a size the way CW_LEAD_MEMORY_MAX is written', () => {
    expect(run(['bytes', '1280M']).stdout.trim()).toBe(String(1280 * 1024 * 1024));
    expect(run(['bytes', '2G']).stdout.trim()).toBe(String(2 * 1024 ** 3));
    expect(run(['bytes', '64k']).stdout.trim()).toBe('65536');
    expect(run(['bytes', '4096']).stdout.trim()).toBe('4096');
    expect(run(['bytes', '1.5G']).status).not.toBe(0);
    expect(run(['bytes', '-1M']).status).not.toBe(0);
  });

  it("counts every process of the lead's uid, by PSS where the kernel has it, and nobody else's", () => {
    const proc = fakeProc([
      { pid: 101, uid: LEAD, rssKb: 900, pssKb: 300 },
      { pid: 102, uid: LEAD, rssKb: 200 },
      // Effective uid only: a lead process is the lead's however it got there.
      { pid: 103, uid: '0', euid: LEAD, rssKb: 50, pssKb: 40 },
      // The server's and root's: never counted.
      { pid: 201, uid: '10001', rssKb: 99999, pssKb: 99999 },
      { pid: 1, uid: '0', rssKb: 5000 },
      // A kernel thread has no memory line.
      { pid: 2, uid: LEAD },
    ]);
    const out = run(['total', LEAD], { CW_MACHINE_PROC_ROOT: proc });
    expect(out.stdout.trim()).toBe(String((300 + 200 + 40) * 1024));
  });

  it("kills all the lead's processes once their total passes a small cap, and only theirs", async () => {
    const proc = fakeProc([
      { pid: 301, uid: LEAD, pssKb: 40 },
      { pid: 302, uid: LEAD, pssKb: 30 },
      { pid: 401, uid: '10001', pssKb: 500 },
    ]);
    const killed = join(scratch, `killed-${Date.now()}`);
    const kill = join(scratch, `kill-${Date.now()}.sh`);
    writeFileSync(kill, `#!/bin/bash\necho "$*" >> "${killed}"\n`, { mode: 0o755 });
    const child = spawn(BASH as string, [script, 'watch', '64K', LEAD], {
      env: {
        PATH: '/usr/bin:/bin',
        CW_MACHINE_PROC_ROOT: proc,
        CW_LEAD_MEMORY_KILL: kill,
        CW_LEAD_MEMORY_POLL: '0.05',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: string[] = [];
    child.stdout?.on('data', (d: Buffer) => out.push(d.toString()));
    try {
      // 70K held against a 64K cap.
      await waitFor(() => readFileSync(killed, 'utf8').length > 0, {
        timeout: 10_000,
        describe: 'the watchdog to kill',
      });
      expect(readFileSync(killed, 'utf8').split('\n')[0]).toBe('-KILL 301 302');
      expect(out.join('')).toContain(
        "the lead's processes hold 70K, over their 64K cap: killing all 2 of them",
      );
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('kills nothing while the lead is under its cap', async () => {
    // POSITIVE CONTROL for the case above: the same processes, a cap above them.
    const proc = fakeProc([
      { pid: 301, uid: LEAD, pssKb: 40 },
      { pid: 302, uid: LEAD, pssKb: 30 },
    ]);
    const killed = join(scratch, `under-${Date.now()}`);
    const polled = join(scratch, `polls-${Date.now()}`);
    const kill = join(scratch, `kill-under-${Date.now()}.sh`);
    writeFileSync(kill, `#!/bin/bash\necho "$*" >> "${killed}"\n`, { mode: 0o755 });
    // Counts polls through sleep, so the test waits for rounds, not time.
    const bin = mkdtempSync(join(scratch, 'bin-'));
    writeFileSync(
      join(bin, 'sleep'),
      `#!/bin/bash\necho . >> "${polled}"\nexec /bin/sleep 0.02\n`,
      {
        mode: 0o755,
      },
    );
    const child = spawn(BASH as string, [script, 'watch', '128K', LEAD], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        CW_MACHINE_PROC_ROOT: proc,
        CW_LEAD_MEMORY_KILL: kill,
      },
      stdio: 'ignore',
    });
    try {
      await waitFor(() => readFileSync(polled, 'utf8').length >= 10, {
        timeout: 10_000,
        describe: 'five polls',
      });
      expect(() => readFileSync(killed, 'utf8')).toThrow();
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('says it cannot cap, and exits, when it cannot read /proc or the size', () => {
    const none = run(['watch', '1280M', LEAD], { CW_MACHINE_PROC_ROOT: join(scratch, 'no-proc') });
    expect(none.status).toBe(2);
    expect(none.stdout).toContain("the lead's memory is NOT capped: cannot read");
    const size = run(['watch', 'lots', LEAD], { CW_MACHINE_PROC_ROOT: fakeProc([]) });
    expect(size.status).toBe(2);
    expect(size.stdout).toContain("the lead's memory is NOT capped: lots is not a size");
  });
});
