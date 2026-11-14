/**
 * How a vitest run splits its files across CI shards and the order each shard
 * starts them in. Files are split by the measured durations in
 * `scripts/vitest-durations.json` (the reasoning is in `scripts/vitest-shard.ts`).
 *
 * TWO KINDS OF SHARD. `CW_VITEST_KIND=browser` keeps only the files that
 * launch Chrome, and `CW_VITEST_KIND=unit` keeps every other file. Each kind
 * is then split across its own shards. CI runs the browser shards with two
 * workers, so no runner has more than two Chrome-launching files running at
 * once. The unit shards keep the full worker count. This file decides which
 * kind a file is; the ordering decides nothing about where it runs. Unset,
 * every file is in the run, as `bun run verify` has it.
 *
 * Why the split exists: with every file in one pool, longest-first started
 * each shard's four heaviest files together, and on a 4-vCPU runner those
 * were four Chrome drivers. That PR's runs failed a browser timing window in
 * 4 of 5 runs, against about 15% on other branches.
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

/**
 * Files that launch a real Chrome without going through the gate. Each
 * resolves the binary itself. They go to the browser shards.
 */
export const LAUNCHES_CHROME_UNGATED: readonly string[] = ['scripts/chrome-orphans.test.ts'];

/** Does the file at `path` call the browser gate? An unreadable file does not. */
export function callsBrowserGate(path: string, read = (p: string) => readFileSync(p, 'utf8')) {
  try {
    return read(path).includes(BROWSER_GATE);
  } catch {
    return false;
  }
}

export type Kind = 'browser' | 'unit';

/** Which shard kind a file belongs to, from its repo-relative path. */
export function kindOf(relPath: string, callsGate: boolean): Kind {
  return callsGate || LAUNCHES_CHROME_UNGATED.includes(relPath) ? 'browser' : 'unit';
}

/** `CW_VITEST_KIND`, or null for every file. Anything else is a typo, and refused. */
export function kindFromEnv(value: string | undefined): Kind | null {
  if (value === undefined || value === '') return null;
  if (value === 'browser' || value === 'unit') return value;
  throw new Error(`CW_VITEST_KIND must be "browser" or "unit"; got "${value}"`);
}

/** The repo-relative path, forward slashes. */
function relPath(root: string, moduleId: string): string {
  return relative(root, moduleId).split('\\').join('/');
}

/** The table's key for a file: `<project>:<repo-relative path>`, forward slashes. */
export function specKey(project: string, root: string, moduleId: string): string {
  return `${project}:${relPath(root, moduleId)}`;
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
    const kind = kindFromEnv(process.env.CW_VITEST_KIND);
    const root = this.ctx.config.root;
    const mine =
      kind === null
        ? files
        : files.filter(
            (s) => kindOf(relPath(root, s.moduleId), callsBrowserGate(s.moduleId)) === kind,
          );
    const { key, weight } = this.weigh();
    return balancedShard(mine, key, weight, shard.index, shard.count);
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { key, weight } = this.weigh();
    return longestFirst(files, key, weight);
  }
}
