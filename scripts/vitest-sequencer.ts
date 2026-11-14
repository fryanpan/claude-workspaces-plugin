/**
 * How a vitest run splits its files across CI shards and the order each shard
 * starts them in: both by the measured durations in
 * `scripts/vitest-durations.json` (the reasoning is `scripts/vitest-shard.ts`).
 *
 * HISTORY. This sequencer first moved every browser-launching file to the
 * front, because vitest queues every `dom` file before any `node` one and
 * `packages/plugin/test/check-mock-render.test.ts` (node, 56s) started late
 * and ran alone to +119s. Longest-first does the same job for any file the
 * table knows, and a file it has not measured still sorts by kind: an
 * unmeasured browser file weighs the median browser file, far above the rest.
 *
 * Locally, where the browser gate is shut and no `--shard` is passed, only the
 * order changes, and the browser files skip their cases whatever their place.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import {
  type Durations,
  balancedShard,
  loadDurations,
  longestFirst,
  weightOf,
} from './vitest-shard.ts';

/** The call a file must make to launch a browser (`scripts/browser-tests.ts`). */
const BROWSER_GATE = 'chromeForSuite(';

/** Does the file at `path` call the browser gate? An unreadable file does not. */
export function callsBrowserGate(path: string, read = (p: string) => readFileSync(p, 'utf8')) {
  try {
    return read(path).includes(BROWSER_GATE);
  } catch {
    return false;
  }
}

/** The table's key for a file: `<project>:<repo-relative path>`, forward slashes. */
export function specKey(project: string, root: string, moduleId: string): string {
  return `${project}:${relative(root, moduleId).split('\\').join('/')}`;
}

export class DurationSequencer extends BaseSequencer {
  private durations: Durations | null = null;

  private weigh(): {
    key: (s: TestSpecification) => string;
    weight: (s: TestSpecification) => number;
  } {
    this.durations ??= loadDurations();
    const durations = this.durations;
    const root = this.ctx.config.root;
    const key = (s: TestSpecification) => specKey(s.project.name, root, s.moduleId);
    const weight = (s: TestSpecification) =>
      weightOf(durations, key(s), callsBrowserGate(s.moduleId));
    return { key, weight };
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const { key, weight } = this.weigh();
    return balancedShard(files, key, weight, shard.index, shard.count);
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { key, weight } = this.weigh();
    return longestFirst(files, key, weight);
  }
}
