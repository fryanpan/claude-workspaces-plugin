/**
 * The capture the supervisor takes before restarting a hung server, and the
 * bound that keeps it from delaying that restart.
 *
 * No real `sample`, `top` or `ps` runs here: the runner is injected, and every
 * wait is a promise the test resolves itself.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CommandResult,
  HANG_CAPTURE_DIR,
  HANG_SAMPLES_KEPT,
  type RunCommand,
  captureHang,
  parseMemoryFree,
  parsePs,
  parseSwap,
  parseTop,
} from '../src/supervisor-hang-capture.ts';
import {
  type HealthProbeResult,
  type HealthVerdict,
  createHealthWatchdog,
} from '../src/supervisor-health.ts';
import { memoryLedger } from './supervisor-ledger-stub.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hang-capture-'));
  dirs.push(d);
  return d;
}

const SWAP = 'vm.swapusage: total = 9216.00M  used = 7873.38M  free = 1342.62M  (encrypted)\n';
const PRESSURE =
  'The system has 17179869184 (1048576 pages with a page size of 16384).\n' +
  'System-wide memory free percentage: 45%\n';
const TOP = 'Processes: 1 total\n\nPID    PAGEINS FAULTS\n4242   1830    99120\n';

/** Answers each command from a table, recording what it was asked. */
function fakeRunner(overrides: Partial<Record<string, () => Promise<CommandResult>>> = {}) {
  const calls: { cmd: string; args: string[]; timeoutMs: number }[] = [];
  const run: RunCommand = (cmd, args, { timeoutMs }) => {
    calls.push({ cmd, args, timeoutMs });
    const o = overrides[cmd];
    if (o) return o();
    const stdout =
      cmd === 'sysctl'
        ? SWAP
        : cmd === 'memory_pressure'
          ? PRESSURE
          : cmd === 'ps'
            ? '  614400 SN\n'
            : cmd === 'top'
              ? TOP
              : '';
    return Promise.resolve({ stdout, code: 0 });
  };
  return { run, calls };
}

describe('parsers', () => {
  it('reads each tool the way macOS prints it', () => {
    expect(parseSwap(SWAP)).toBe('used 7873.38M of 9216.00M');
    expect(parseMemoryFree(PRESSURE)).toBe('45%');
    expect(parsePs('  614400 SN\n')).toEqual({ rssMb: 600, state: 'SN' });
    expect(parseTop(TOP, 4242)).toEqual({ pageins: 1830, faults: 99120 });
    expect(parseTop(TOP, 1)).toBeNull();
    expect(parseSwap('garbage')).toBeNull();
  });
});

describe('captureHang', () => {
  it('samples the pid into the data dir and logs every reading', async () => {
    const dataDir = tempDir();
    const { run, calls } = fakeRunner();
    const lines: string[] = [];
    await captureHang({ pid: 4242, dataDir, run, log: (l) => lines.push(l), now: () => 0 });

    const sample = calls.find((c) => c.cmd === 'sample');
    expect(sample?.args.slice(0, 3)).toEqual(['4242', '2', '-mayDie']);
    const path = sample?.args[4] as string;
    expect(path.startsWith(join(dataDir, HANG_CAPTURE_DIR))).toBe(true);
    const text = lines.join('\n');
    expect(text).toContain(`written to ${path}`);
    expect(text).toContain('swap used 7873.38M of 9216.00M');
    expect(text).toContain('memory free 45%');
    expect(text).toContain('RSS 600MB, ps state SN');
    expect(text).toContain('1830 page-ins');
    expect(text).toContain('not readable from here');
  });

  it('logs a failed reading and still logs the others', async () => {
    const { run } = fakeRunner({
      sample: () => Promise.resolve({ stdout: '', code: null, timedOut: true }),
      sysctl: () => Promise.reject(new Error('spawn ENOENT')),
    });
    const lines: string[] = [];
    await captureHang({ pid: 4242, dataDir: tempDir(), run, log: (l) => lines.push(l) });
    const text = lines.join('\n');
    expect(text).toContain('stack sample of pid 4242 failed (timed out)');
    expect(text).toContain('swap unread');
    expect(text).toContain('memory free 45%');
  });

  it('keeps only the newest samples', async () => {
    const dataDir = tempDir();
    const dir = join(dataDir, HANG_CAPTURE_DIR);
    await captureHang({ pid: 1, dataDir, run: fakeRunner().run, log: () => {} });
    for (let i = 0; i < HANG_SAMPLES_KEPT + 3; i++) {
      writeFileSync(join(dir, `sample-2026-01-${String(i).padStart(2, '0')}.txt`), 'x');
    }
    writeFileSync(join(dir, 'notes.txt'), 'kept');
    await captureHang({ pid: 1, dataDir, run: fakeRunner().run, log: () => {} });
    const samples = readdirSync(dir).filter((f) => f.startsWith('sample-'));
    // The fake runner writes no file, so what is left is the survivors of the prune.
    expect(samples.length).toBe(HANG_SAMPLES_KEPT - 1);
    expect(samples).not.toContain('sample-2026-01-00.txt');
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });
});

describe('the watchdog runs the capture before a hang restart', () => {
  const POLICY = { max: 3, windowMs: 3_600_000 };

  function dog(
    verdicts: HealthVerdict[],
    capture: () => Promise<void>,
    wait: (ms: number) => Promise<void>,
  ) {
    const events: string[] = [];
    let i = 0;
    const d = createHealthWatchdog({
      probe: async (): Promise<HealthProbeResult> => ({
        verdict: verdicts[Math.min(i++, verdicts.length - 1)] as HealthVerdict,
      }),
      maxFails: 2,
      ledger: memoryLedger(),
      policy: POLICY,
      now: () => 1_000_000,
      log: () => {},
      restart: () => events.push('restart'),
      label: ':8873',
      firstBindGraceMs: 0,
      captureBeforeRestart: () => {
        events.push('capture');
        return capture();
      },
      captureBudgetMs: 6_000,
      wait,
    });
    return { d, events };
  }
  const never = () => new Promise<void>(() => {});

  it('a no-answer restart captures, then restarts', async () => {
    const { d, events } = dog(['no-answer'], async () => {}, never);
    expect(await d.tick()).toBe('wait');
    expect(events).toEqual([]);
    expect(await d.tick()).toBe('restart');
    expect(events).toEqual(['capture', 'restart']);
  });

  it('a capture that never ends costs the budget and no more', async () => {
    const waited: number[] = [];
    const { d, events } = dog(['no-answer'], never, async (ms) => {
      waited.push(ms);
    });
    await d.tick();
    expect(await d.tick()).toBe('restart');
    expect(waited).toEqual([6_000]);
    expect(events).toEqual(['capture', 'restart']);
  });

  it('a capture that throws still restarts', async () => {
    const { d, events } = dog(
      ['no-answer'],
      () => {
        throw new Error('boom');
      },
      never,
    );
    await d.tick();
    expect(await d.tick()).toBe('restart');
    expect(events).toEqual(['capture', 'restart']);
  });

  it('a healthy server is never captured', async () => {
    const { d, events } = dog(['answering'], async () => {}, never);
    for (let n = 0; n < 5; n++) expect(await d.tick()).toBe('ok');
    expect(events).toEqual([]);
  });

  it('an unbound restart is not a hang and takes no capture', async () => {
    const { d, events } = dog(['not-listening'], async () => {}, never);
    await d.tick();
    expect(await d.tick()).toBe('restart');
    expect(events).toEqual(['restart']);
  });
});
