#!/usr/bin/env bun
/**
 * Start a Mac lead's `claude` under a Seatbelt profile that walls it off
 * from other projects' files. Needs no sudo and no admin password, so an
 * agent applies it. Runbook: `docs/process/lead-sandbox.md`. What the
 * profile holds: `lead-sandbox-lib.ts`.
 *
 *   bun scripts/lead-sandbox.ts --config <file>                 # dry run: profiles + launch commands
 *   bun scripts/lead-sandbox.ts --config <file> --write         # write the profiles
 *   bun scripts/lead-sandbox.ts --config <file> --check         # prove each wall from inside it
 *   bun scripts/lead-sandbox.ts --config <file> --lead <name> -- claude [args]   # launch
 *
 * Profiles go to `~/.config/claude-workspaces/lead-sandbox/`, or to
 * `--profiles <dir>`. A config path or profile folder given relative is
 * taken from the current folder.
 *
 * `--check` lists each lead's own projects (they must list: the control)
 * and each protected folder (it must refuse) from inside that lead's
 * profile, and exits 1 on any failure.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type Lead,
  type LeadSandboxConfig,
  type Machine,
  SANDBOX_EXEC,
  buildProfile,
  checkTargets,
  launchCommand,
  parseConfig,
} from './lead-sandbox-lib.ts';
import { shellQuote } from './mac-lead-users-lib.ts';

const machine: Machine = {
  home: homedir(),
  uid: process.getuid?.() ?? 0,
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
};

const PROFILE_DIR = join(homedir(), '.config', 'claude-workspaces', 'lead-sandbox');
let profileDir = PROFILE_DIR;

function profilePath(lead: Lead): string {
  return join(profileDir, `${lead.name}.sb`);
}

function writeProfile(lead: Lead, config: LeadSandboxConfig, guard: string[]): string {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const path = profilePath(lead);
  writeFileSync(path, buildProfile(lead, config, machine, guard), { mode: 0o600 });
  return path;
}

/** Whether `/bin/ls` lists `path` from inside the profile. */
function lists(profile: string, path: string): boolean {
  const r = spawnSync(SANDBOX_EXEC, ['-f', profile, '/bin/ls', path], { stdio: 'ignore' });
  return r.status === 0;
}

function main(argv: string[]): number {
  const say = (line: string) => process.stdout.write(`${line}\n`);
  if (process.platform !== 'darwin') {
    say('Seatbelt is macOS only.');
    return 2;
  }
  const dashes = argv.indexOf('--');
  const own = dashes >= 0 ? argv.slice(0, dashes) : argv;
  const command = dashes >= 0 ? argv.slice(dashes + 1) : [];
  const flag = (name: string) => {
    const at = own.indexOf(name);
    return at >= 0 ? own[at + 1] : undefined;
  };
  const given = flag('--config');
  if (!given) {
    say(
      'usage: bun scripts/lead-sandbox.ts --config <file> [--write | --check | --lead <name> -- <command>]',
    );
    return 2;
  }
  const file = resolve(given);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    say(
      `config refused: ${file} is not readable JSON (${err instanceof Error ? err.message : err})`,
    );
    return 2;
  }
  const parsed = parseConfig(raw, machine.home);
  if (!parsed.ok) {
    say(`config refused: ${parsed.error}`);
    return 2;
  }
  const { config } = parsed;
  profileDir = resolve(flag('--profiles') ?? PROFILE_DIR);
  const guard = [file, profileDir];

  const leadName = flag('--lead');
  if (leadName !== undefined) {
    const lead = config.leads.find((l) => l.name === leadName);
    if (!lead) {
      say(`no lead named ${leadName} in ${file}`);
      return 2;
    }
    if (command.length === 0) {
      say('nothing to launch: put the command after --');
      return 2;
    }
    const here = machine.realpath(import.meta.dirname);
    if (lead.projects.some((p) => here.startsWith(`${machine.realpath(p)}/`)))
      say(
        `warning: this script runs from ${here}, inside ${lead.name}'s own project, so the lead can edit the generator of its next profile. Launch from prod's checkout.`,
      );
    const launch = launchCommand(lead, writeProfile(lead, config, guard), command);
    // Ctrl-C interrupts the lead's turn; it must not kill this wrapper and
    // leave the session running without its parent.
    for (const sig of ['SIGINT', 'SIGQUIT'] as const) process.on(sig, () => {});
    const r = spawnSync(launch.argv[0] ?? SANDBOX_EXEC, launch.argv.slice(1), {
      cwd: launch.cwd,
      stdio: 'inherit',
    });
    return r.status ?? 1;
  }

  if (own.includes('--check')) {
    let bad = 0;
    let total = 0;
    for (const lead of config.leads) {
      const profile = writeProfile(lead, config, guard);
      const t = checkTargets(lead, config, machine);
      for (const [path, must] of [
        ...t.own.map((p) => [p, true] as const),
        ...t.protected.map((p) => [p, false] as const),
      ]) {
        const listed = lists(profile, path);
        const ok = listed === must;
        total++;
        if (!ok) bad++;
        const what = must ? 'own project (must list)' : 'protected (must not list)';
        say(
          `${ok ? 'ok  ' : 'FAIL'} ${lead.name}  ${listed ? 'lists' : 'refused'}  ${path}  ${what}`,
        );
      }
    }
    say(bad === 0 ? `All ${total} checks hold.` : `${bad} of ${total} checks failed.`);
    return bad === 0 ? 0 : 1;
  }

  const write = own.includes('--write');
  for (const lead of config.leads) {
    const path = profilePath(lead);
    if (write) writeProfile(lead, config, guard);
    else {
      say(`# ${path}`);
      say(buildProfile(lead, config, machine, guard));
    }
    const wrapper = ['bun', join(import.meta.dirname, 'lead-sandbox.ts'), '--config', file];
    if (profileDir !== PROFILE_DIR) wrapper.push('--profiles', profileDir);
    say(`${lead.name}: ${shellQuote([...wrapper, '--lead', lead.name, '--', 'claude'])}`);
    const launch = launchCommand(lead, path, ['claude']);
    say(`  which runs, in ${launch.cwd}: ${shellQuote(launch.argv)}`);
  }
  say(
    write
      ? `Wrote ${config.leads.length} profile(s) to ${profileDir}.`
      : 'Dry run. Nothing was written.',
  );
  return 0;
}

process.exit(main(process.argv.slice(2)));
