/**
 * Build this Astro fixture into `out`, one build at a time.
 *
 * `--outDir` moves only the output. Astro still writes its prerender chunks
 * and generated types under the fixture's own `.astro/`, so two builds at once
 * overwrite each other's chunks. On CI run 45662316535 astro-map and
 * astro-page shared a shard, built together, and one build loaded the other's
 * half-written manifest (`undefined is not an object (evaluating
 * 'encoded.length')` in deserializeManifest). A lock directory beside the
 * fixture serialises the builds across vitest's worker processes.
 *
 * Built with bun, which every CI job installs, not the runner's node: Astro 7
 * asks for node >=22.23.4 and no job pins a node.
 */
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = join(import.meta.dirname, '..');
const LOCK = join(FIXTURE, '.astro-build.lock');
/** Longer than any build takes (the build's own timeout is 120s), so a lock
 *  this old was left by a process that died holding it. */
const STALE_MS = 150_000;

async function acquire(): Promise<void> {
  for (;;) {
    try {
      mkdirSync(LOCK);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) {
        rmSync(LOCK, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue; // released between mkdir and stat
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function buildFixture(out: string): Promise<SpawnSyncReturns<string>> {
  await acquire();
  try {
    return spawnSync(
      'bun',
      [join(FIXTURE, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'build', '--outDir', out],
      {
        cwd: FIXTURE,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      },
    );
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}
