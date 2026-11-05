/**
 * The Fly machine size for a project's memory.
 *
 * Fly's rule (https://docs.fly.io/machines/guides-examples/machine-sizing):
 * a shared CPU holds 256 MB to 2 GB of memory, so the maximum is "2gb *
 * shared CPU size" and the minimum "256m * shared CPU size", and custom
 * memory is a multiple of 256 MB. A performance CPU holds 2-8 GB, in 2 GB
 * steps, and costs more (performance-1x with 2 GB is $33.00 a month,
 * shared-cpu-2x with 2 GB $13.39: https://docs.fly.io/about/pricing). So
 * memory alone never needs one: up to 16 GB fits on eight shared CPUs.
 */
const MIN_MEMORY_MB = 256;
const MAX_MEMORY_MB = 16384;
const STEP_MB = 256;
const SHARED_MB_PER_CPU = 2048;
const SHARED_CPUS = [1, 2, 4, 8];

/** The memory, checked against what Fly accepts, or an error naming the range. */
function checkMemory(memoryMb: number): void {
  if (
    !Number.isInteger(memoryMb) ||
    memoryMb < MIN_MEMORY_MB ||
    memoryMb > MAX_MEMORY_MB ||
    memoryMb % STEP_MB !== 0
  ) {
    throw new Error(
      `memory must be ${MIN_MEMORY_MB}-${MAX_MEMORY_MB} MB, in steps of ${STEP_MB}, got ${memoryMb}`,
    );
  }
}

/** The fewest shared CPUs that may hold this much memory, as Fly's size name. */
export function vmSizeFor(memoryMb: number): string {
  checkMemory(memoryMb);
  const cpus = SHARED_CPUS.find((n) => n * SHARED_MB_PER_CPU >= memoryMb) ?? 8;
  return `shared-cpu-${cpus}x`;
}
