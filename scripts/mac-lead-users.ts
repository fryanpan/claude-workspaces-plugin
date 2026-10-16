#!/usr/bin/env bun
/**
 * Give each Mac lead and helper a macOS user of its own, walled off from the
 * owner's folders. The owner runs it; an agent never does. Runbook:
 * `docs/process/mac-lead-users.md`. What it does: `mac-lead-users-lib.ts`.
 *
 *   bun scripts/mac-lead-users.ts --config <file>            # dry run: prints the plan
 *   sudo bun scripts/mac-lead-users.ts --config <file> --apply
 *   sudo bun scripts/mac-lead-users.ts --config <file> --check
 *
 * The dry run is the default and changes nothing. `--apply` prints each
 * change before it makes it and stops at the first failure. `--check` lists
 * each protected folder as each lead user and fails if any can be read.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import {
  DSCL,
  type System,
  apply,
  check,
  parseConfig,
  plan,
  shellQuote,
} from './mac-lead-users-lib.ts';

const realSystem: System = {
  run(argv, opts) {
    const [bin, ...args] = argv;
    const r = spawnSync(bin ?? '', args, {
      encoding: 'utf8',
      stdio: opts?.interactive ? 'inherit' : 'pipe',
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
  isRoot: () => process.getuid?.() === 0,
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
  isDirectory(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};

/** The home of the person running this, through sudo or not. */
function ownerHome(sys: System): string[] {
  const who = process.env.SUDO_USER || process.env.USER;
  if (!who) return [];
  const r = sys.run([DSCL, '.', '-read', `/Users/${who}`, 'NFSHomeDirectory']);
  const home = r.stdout.match(/NFSHomeDirectory:\s*(\S.*)$/m)?.[1]?.trim();
  return home ? [home] : [];
}

function main(argv: string[]): number {
  const say = (line: string) => process.stdout.write(`${line}\n`);
  if (process.platform !== 'darwin') {
    say('This script makes macOS users; it runs on macOS only.');
    return 2;
  }
  const at = argv.indexOf('--config');
  const file = at >= 0 ? argv[at + 1] : undefined;
  if (!file) {
    say('usage: bun scripts/mac-lead-users.ts --config <file> [--apply | --check]');
    return 2;
  }
  const mode = argv.includes('--apply') ? 'apply' : argv.includes('--check') ? 'check' : 'dry-run';
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    say(
      `config refused: ${file} is not readable JSON (${err instanceof Error ? err.message : String(err)})`,
    );
    return 2;
  }
  const parsed = parseConfig(raw, ownerHome(realSystem));
  if (!parsed.ok) {
    say(`config refused: ${parsed.error}`);
    return 2;
  }
  const { config } = parsed;

  if (mode === 'check') {
    if (!realSystem.isRoot()) {
      say('refused: --check lists folders as each lead user, so run it with sudo.');
      return 2;
    }
    const rows = check(realSystem, config);
    for (const r of rows) {
      const verdict = r.ok ? 'ok  ' : 'FAIL';
      const what = r.kind === 'own' ? 'its own home (must list)' : 'protected (must not list)';
      say(`${verdict} ${r.user}  ${r.readable ? 'lists' : 'refused'}  ${r.path}  ${what}`);
    }
    const bad = rows.filter((r) => !r.ok).length;
    say(bad === 0 ? `All ${rows.length} checks hold.` : `${bad} of ${rows.length} checks failed.`);
    return bad === 0 ? 0 : 1;
  }

  const p = plan(realSystem, config);
  say(`Protected folders: ${p.protectedPaths.join(', ')}`);
  for (const problem of p.problems) say(`not touched: ${problem.says}`);
  if (p.changes.length === 0) {
    say('Nothing to change: every user and every deny entry is already in place.');
    return p.problems.length === 0 ? 0 : 1;
  }
  if (mode === 'dry-run') {
    say(`Dry run. ${p.changes.length} change(s) would be made, in this order:`);
    for (const c of p.changes) {
      say(`→ ${c.says}`);
      say(`  $ ${shellQuote(c.argv)}`);
    }
    say('Nothing was changed. Run again with sudo and --apply to make them.');
    return 0;
  }
  const r = apply(realSystem, p.changes, say);
  say(r.ok ? `Done: ${r.made} change(s) made.` : `Stopped after ${r.made} change(s).`);
  return r.ok && p.problems.length === 0 ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
