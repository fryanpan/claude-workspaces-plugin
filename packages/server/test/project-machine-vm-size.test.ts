/**
 * The machine size `machine:deploy` asks Fly for, from `--memory`. Fly holds
 * a shared CPU to 256 MB-2 GB of memory, in 256 MB steps
 * (https://docs.fly.io/machines/guides-examples/machine-sizing), so a bigger
 * machine needs more CPUs, and a size Fly would refuse is refused here first.
 */
import { describe, expect, it } from 'bun:test';
import { projectConfig, renderFlyToml } from '../../../infra/project-machine/deploy-plan.ts';

const SHA = 'a'.repeat(40);
const config = (vmMemoryMb?: number) =>
  projectConfig({
    project: 'riverbend',
    imageLabel: SHA,
    ...(vmMemoryMb !== undefined ? { vmMemoryMb } : {}),
  });

/** Fly's own rule for a `shared-cpu-<n>x` machine. */
function flyAccepts(size: string, memoryMb: number): boolean {
  const m = /^shared-cpu-(\d+)x$/.exec(size);
  if (!m) return false;
  const cpus = Number(m[1]);
  return memoryMb % 256 === 0 && memoryMb >= 256 * cpus && memoryMb <= 2048 * cpus;
}

describe('machine:deploy sizes the machine from --memory', () => {
  it('accepts 16384 MB on a size Fly accepts', () => {
    const cfg = config(16384);
    expect(cfg.vmMemoryMb).toBe(16384);
    expect(cfg.vmSize).toBe('shared-cpu-8x');
    const toml = renderFlyToml('app = "x"\nprimary_region = "sjc"\n[[vm]]\n', cfg);
    expect(toml).toContain('size = "shared-cpu-8x"\n  memory = "16384mb"');
  });

  it('keeps the defaults: 512 MB on one shared CPU', () => {
    const cfg = config();
    expect(cfg.vmMemoryMb).toBe(512);
    expect(cfg.vmSize).toBe('shared-cpu-1x');
  });

  it('picks the fewest shared CPUs Fly allows for each size', () => {
    const want: [number, string][] = [
      [256, 'shared-cpu-1x'],
      [1024, 'shared-cpu-1x'],
      [2048, 'shared-cpu-1x'],
      [2304, 'shared-cpu-2x'],
      [4096, 'shared-cpu-2x'],
      [4352, 'shared-cpu-4x'],
      [8192, 'shared-cpu-4x'],
      [8448, 'shared-cpu-8x'],
      [16384, 'shared-cpu-8x'],
    ];
    for (const [mb, size] of want) expect([mb, config(mb).vmSize]).toEqual([mb, size]);
  });

  it('never asks Fly for a size it refuses', () => {
    for (let mb = 256; mb <= 16384; mb += 256) {
      const { vmSize } = config(mb);
      expect([mb, vmSize, flyAccepts(vmSize, mb)]).toEqual([mb, vmSize, true]);
    }
  });

  it('refuses memory outside 256-16384 MB or off a 256 MB step', () => {
    for (const mb of [100, 255, 16640, 32768, 300, 1000, 2047.5, Number.NaN]) {
      expect(() => config(mb)).toThrow('memory must be 256-16384 MB, in steps of 256');
    }
  });
});
