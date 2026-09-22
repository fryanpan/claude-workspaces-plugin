import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { createFootprintReader } from '../src/memory-footprint.ts';

const onDarwin = process.platform === 'darwin';

describe('footprint reader', () => {
  it.skipIf(!onDarwin)('reads the footprint macOS reports for this process', () => {
    const fp = createFootprintReader()();
    expect(fp).not.toBeNull();
    if (!fp) return;
    expect(fp.footprintMb).toBeGreaterThan(0);
    expect(fp.peakMb).toBeGreaterThanOrEqual(fp.footprintMb);
    // `ri_resident_size` sits two fields before the footprint, so agreeing
    // with the runtime's own RSS is what shows the struct offsets are right.
    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    expect(Math.abs(fp.residentMb - rssMb)).toBeLessThan(rssMb * 0.1 + 16);
  });

  it.skipIf(!onDarwin || !existsSync('/usr/bin/footprint'))(
    'agrees with /usr/bin/footprint on the footprint and its peak',
    () => {
      const read = createFootprintReader();
      const out = Bun.spawnSync(['/usr/bin/footprint', String(process.pid)]).stdout.toString();
      const fp = read();
      const mb = (re: RegExp): number | null => {
        const m = re.exec(out);
        return m ? Number(m[1]) * (m[2] === 'GB' ? 1024 : 1) : null;
      };
      const now = mb(/phys_footprint: ([\d.]+) (MB|GB)/);
      const peak = mb(/phys_footprint_peak: ([\d.]+) (MB|GB)/);
      expect(now).not.toBeNull();
      expect(peak).not.toBeNull();
      if (now === null || peak === null || !fp) return;
      expect(Math.abs(fp.footprintMb - now)).toBeLessThan(now * 0.1 + 16);
      // The peak is a high-water mark, so only a wrong offset moves it far:
      // the neighbouring field, `ri_instructions`, reads in the thousands.
      expect(Math.abs(fp.peakMb - peak)).toBeLessThan(peak * 0.1 + 16);
    },
  );

  it.skipIf(!onDarwin)('moves when the process touches memory', () => {
    const read = createFootprintReader();
    const before = read();
    const held = new Uint8Array(192 * 1024 * 1024).fill(7);
    const after = read();
    expect(held[held.length - 1]).toBe(7);
    expect(before && after).toBeTruthy();
    if (!before || !after) return;
    expect(after.footprintMb - before.footprintMb).toBeGreaterThan(128);
    expect(after.peakMb).toBeGreaterThanOrEqual(after.footprintMb);
  });

  it('answers null off darwin without loading anything', () => {
    let loads = 0;
    const read = createFootprintReader({
      platform: 'linux',
      load: () => {
        loads++;
        return () => 0;
      },
    });
    expect(read()).toBeNull();
    expect(loads).toBe(0);
  });

  it('answers null, and stops trying, when the library will not load', () => {
    let loads = 0;
    const read = createFootprintReader({
      platform: 'darwin',
      load: () => {
        loads++;
        throw new Error('dlopen failed');
      },
    });
    expect(read()).toBeNull();
    expect(read()).toBeNull();
    expect(loads).toBe(1);
  });

  it('answers null when the call reports failure', () => {
    const read = createFootprintReader({ platform: 'darwin', load: () => () => -1 });
    expect(read()).toBeNull();
  });

  it('decodes the fields from their offsets in rusage_info_v4', () => {
    const MB = 1024 * 1024;
    const read = createFootprintReader({
      platform: 'darwin',
      load: () => (_pid, flavor, buf) => {
        expect(flavor).toBe(4);
        const v = new DataView(buf.buffer);
        v.setBigUint64(64, BigInt(300 * MB), true);
        v.setBigUint64(72, BigInt(900 * MB), true);
        v.setBigUint64(240, BigInt(3437 * MB), true);
        v.setBigUint64(248, BigInt(1), true);
        return 0;
      },
    });
    expect(read()).toEqual({ footprintMb: 900, peakMb: 3437, residentMb: 300 });
  });
});
