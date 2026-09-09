#!/usr/bin/env bun
/**
 * Run the doc-identity migration by hand.
 *
 * The migration itself is `packages/server/src/doc-identity-migration.ts` —
 * this file is the only thing that reaches a real data directory, which is
 * what keeps a test run and a stray import from migrating a machine. The
 * server never calls either: a corpus walk that spawns git and hydrates
 * documents is not something a restart should do, and a bug in one is not
 * something anybody could stop.
 *
 *   bun scripts/migrate-doc-identity.ts --data-dir <dir>            # dry run
 *   bun scripts/migrate-doc-identity.ts --data-dir <dir> --apply
 *   bun scripts/migrate-doc-identity.ts --data-dir <dir> --revert
 *   bun scripts/migrate-doc-identity.ts --data-dir <dir> --check
 *
 * `--dry-run` is accepted and is the default. Dry first, always: the report
 * it prints is the same plan `--apply` executes.
 *
 * `--check` is the only mode that is safe with the server running: it opens
 * the journal and the `.ydoc` files read-only and writes nothing at all, so
 * it can answer "are the merged conversations still there" long after the
 * run, when a lost write would come from something the run never saw.
 */

import { existsSync } from 'node:fs';
import { checkLines, checkMerges } from '../packages/server/src/doc-identity-check.ts';
import { revert } from '../packages/server/src/doc-identity-journal.ts';
import { applyPlan, liveIo, reportLines } from '../packages/server/src/doc-identity-migration.ts';
import { planMigration } from '../packages/server/src/doc-identity-plan.ts';
import { RepoRegistry } from '../packages/server/src/repo-registry.ts';

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataDir = value('data-dir');
  if (!dataDir || !existsSync(dataDir)) {
    console.error('usage: bun scripts/migrate-doc-identity.ts --data-dir <dir> [--apply|--revert]');
    process.exit(2);
  }
  if (flag('check')) {
    // Before the registry is constructed: a check writes nothing, and
    // building a RepoRegistry is how a stale in-memory copy gets written.
    const res = checkMerges(dataDir);
    console.log(checkLines(res).join('\n'));
    process.exit(res.ok ? 0 : 1);
  }
  const registry = new RepoRegistry(dataDir);
  if (flag('revert')) {
    const res = revert(dataDir, registry);
    console.log(`released ${res.released} key claims across ${res.runs} run(s).`);
    console.log(`${res.mergesLeftInPlace} merged conversation(s) left in place — see the journal.`);
    process.exit(0);
  }
  const plan = planMigration(liveIo(dataDir));
  if (!flag('apply')) {
    console.log('DRY RUN — nothing written. Pass --apply to file these claims.\n');
    console.log(reportLines(plan).join('\n'));
    process.exit(0);
  }
  const applied = applyPlan(dataDir, plan, registry);
  console.log(reportLines(plan, applied).join('\n'));
}
