/**
 * The supervisor's pre-spawn steps name themselves in the log. On 20 November
 * a restart spent 14 silent minutes before spawning the server; these cases
 * drive the step wrapper with an injected clock and timer and read the lines
 * it wrote.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBootSteps, runInherited } from '../src/supervisor-boot-steps.ts';
import { waitFor } from './wait-for.ts';

function harness() {
  const lines: string[] = [];
  let clock = 1_000_000;
  let beat: (() => void) | null = null;
  let cleared = 0;
  const steps = createBootSteps({
    log: (l) => lines.push(l),
    now: () => clock,
    setInterval: (fn) => {
      beat = fn;
      return 1;
    },
    clearInterval: () => {
      cleared++;
      beat = null;
    },
  });
  return {
    steps,
    lines,
    advance: (ms: number) => {
      clock += ms;
    },
    fire: () => beat?.(),
    cleared: () => cleared,
  };
}

describe('createBootSteps', () => {
  it('logs a start line before the step runs, so a step that never returns is named', async () => {
    const h = harness();
    h.advance(5_000);
    let seenBeforeRun: string[] = [];
    await h.steps.step('bun install', () => {
      seenBeforeRun = [...h.lines];
    });
    expect(seenBeforeRun).toEqual(['[supervisor] boot: bun install started, 5s after launch']);
  });

  it('logs how long a step took', async () => {
    const h = harness();
    const out = await h.steps.step('widget build', () => {
      h.advance(612_000);
      return 7;
    });
    expect(out).toBe(7);
    expect(h.lines.at(-1)).toBe('[supervisor] boot: widget build took 612s');
  });

  it('says a running async step is still running, and stops saying it once it returns', async () => {
    const h = harness();
    let finish: () => void = () => {};
    const running = h.steps.step(
      'workspaces-app build',
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    h.advance(60_000);
    h.fire();
    h.advance(60_000);
    h.fire();
    expect(h.lines.filter((l) => l.includes('still running'))).toEqual([
      '[supervisor] boot: workspaces-app build still running after 60s (60s after launch); the server is not spawned until it returns',
      '[supervisor] boot: workspaces-app build still running after 120s (120s after launch); the server is not spawned until it returns',
    ]);
    finish();
    await running;
    expect(h.cleared()).toBe(1);
    h.fire();
    expect(h.lines.filter((l) => l.includes('still running'))).toHaveLength(2);
  });

  it('names a step that threw and passes the error on', async () => {
    const h = harness();
    const run = h.steps.step('deploy source', () => {
      h.advance(5_000);
      throw new Error('boom');
    });
    await expect(run).rejects.toThrow('boom');
    expect(h.lines.at(-1)).toBe('[supervisor] boot: deploy source threw after 5s');
    expect(h.cleared()).toBe(1);
  });
});

describe('runInherited', () => {
  it('resolves with the exit status of the command', async () => {
    expect(await runInherited(process.execPath, ['-e', 'process.exit(3)'])).toBe(3);
    expect(await runInherited(process.execPath, ['-e', ''])).toBe(0);
  });

  it('kills the command when this process exits mid-build', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boot-steps-'));
    try {
      const pidFile = join(dir, 'pid');
      const parent = join(dir, 'parent.ts');
      writeFileSync(
        parent,
        `import { runInherited } from ${JSON.stringify(join(import.meta.dir, '../src/supervisor-boot-steps.ts'))};\n` +
          `void runInherited(process.execPath, ['-e', 'require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)']);\n` +
          `setInterval(() => { if (require('fs').existsSync(${JSON.stringify(pidFile)})) process.exit(0); }, 20);\n`,
      );
      const proc = Bun.spawn([process.execPath, parent], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      expect(await proc.exited).toBe(0);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      const alive = (): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      await waitFor(() => !alive());
      expect(alive()).toBe(false);
    } finally {
      // A failing run would otherwise leave the child holding this run's stdout.
      try {
        process.kill(Number(readFileSync(join(dir, 'pid'), 'utf8')), 'SIGKILL');
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves null when the command cannot be started', async () => {
    expect(await runInherited('/nonexistent/cw-no-such-binary', [])).toBeNull();
  });
});
