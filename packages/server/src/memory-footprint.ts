/**
 * The process's memory as macOS counts it: `phys_footprint`, the number
 * Activity Monitor's Memory column, `/usr/bin/footprint` and jetsam all read.
 *
 * RSS is not that number. It leaves out pages the kernel has compressed or
 * swapped, which is where a burst goes once the Mac is under pressure: on
 * 2026-09-22 prod peaked at 3,437 MB footprint while the log's RSS never
 * read above 881 MB. So the memory log reads this and prints RSS beside it.
 *
 * Read through `proc_pid_rusage(getpid(), RUSAGE_INFO_V4, buf)`. In
 * `struct rusage_info_v4` (sys/resource.h) a 16-byte uuid is followed by
 * u64 fields, so `ri_resident_size` is at byte 64, `ri_phys_footprint` at 72
 * and `ri_lifetime_max_phys_footprint` at 240 (the 29th u64). The lifetime maximum is the
 * kernel's own high-water mark: it moves when a burst came and went between
 * two samples, which a 30-second sampler would otherwise never see.
 *
 * Never throws. Off darwin, or when the FFI load or the call fails, the
 * answer is `null` and stays `null`: a memory sample is not worth a crash,
 * and a load that failed once will fail every time.
 */
import { FFIType, dlopen, ptr } from 'bun:ffi';

const RUSAGE_INFO_V4 = 4;
/** sizeof(struct rusage_info_v4) is 296; the buffer is rounded up. */
const BUFFER_BYTES = 512;
const RESIDENT_OFFSET = 64;
const FOOTPRINT_OFFSET = 72;
const LIFETIME_MAX_OFFSET = 240;
const MB = 1024 * 1024;

export interface Footprint {
  /** `ri_phys_footprint` now, in MB. */
  footprintMb: number;
  /** `ri_lifetime_max_phys_footprint`: the highest footprint since exec, in MB. */
  peakMb: number;
  /** `ri_resident_size`, in MB — the kernel's RSS, for cross-checking. */
  residentMb: number;
}

/** The one call this module makes: fill `buf` for `pid`, return 0 on success. */
export type RusageCall = (pid: number, flavor: number, buf: Uint8Array) => number;

/** Opens the library. Injected so a test can make the load fail. */
export type RusageLoader = () => RusageCall;

export function loadLibprocRusage(): RusageCall {
  const lib = dlopen('/usr/lib/libproc.dylib', {
    proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  return (pid, flavor, buf) => lib.symbols.proc_pid_rusage(pid, flavor, ptr(buf));
}

export interface FootprintReaderOptions {
  platform?: string;
  load?: RusageLoader;
  pid?: number;
}

/**
 * Build a reader. The library is opened on the first call, not here, so a
 * process that never samples never loads it.
 */
export function createFootprintReader(opts: FootprintReaderOptions = {}): () => Footprint | null {
  const platform = opts.platform ?? process.platform;
  const load = opts.load ?? loadLibprocRusage;
  const pid = opts.pid ?? process.pid;
  const buf = new Uint8Array(BUFFER_BYTES);
  const view = new DataView(buf.buffer);
  let call: RusageCall | null = null;
  let broken = platform !== 'darwin';
  return () => {
    if (broken) return null;
    try {
      call ??= load();
      if (call(pid, RUSAGE_INFO_V4, buf) !== 0) return null;
      const footprint = Number(view.getBigUint64(FOOTPRINT_OFFSET, true));
      if (footprint <= 0) return null;
      return {
        footprintMb: Math.round(footprint / MB),
        peakMb: Math.round(Number(view.getBigUint64(LIFETIME_MAX_OFFSET, true)) / MB),
        residentMb: Math.round(Number(view.getBigUint64(RESIDENT_OFFSET, true)) / MB),
      };
    } catch {
      broken = true;
      return null;
    }
  };
}
