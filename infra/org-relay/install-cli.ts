#!/usr/bin/env bun
/**
 * `bun run relay:install`: the arguments and the real IO for `install.ts`,
 * which says what each step does.
 *
 *   bun run relay:install                       install, or bring an install up to date
 *   bun run relay:install --dry-run             print the plan, tokens redacted; write nothing
 *   bun run relay:install --remint              mint every token again
 *   bun run relay:install --board <seat>=<id>   name a seat's board when the lookup cannot
 *   bun run relay:install --home-remotes <path> the file CW_HOME_REMOTES_FILE names
 *                                               (default: that variable)
 *   bun run relay:install --no-server-restart   print the Mac server's restart instead
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type InstallOptions, runInstall } from './install.ts';

export function parseArgs(argv: readonly string[]): InstallOptions {
  const opts: InstallOptions = { dryRun: false, remint: false, boards: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--remint') opts.remint = true;
    else if (a === '--board') {
      const m = /^([A-Za-z0-9_-]+)=([A-Za-z0-9_-]+)$/.exec(argv[++i] ?? '');
      if (!m) throw new Error('--board takes <seat>=<board id>');
      opts.boards.set(m[1] as string, m[2] as string);
    } else if (a === '--home-remotes') {
      const path = argv[++i];
      if (!path) throw new Error('--home-remotes takes the path CW_HOME_REMOTES_FILE names');
      opts.homeRemotes = path;
    } else if (a === '--no-server-restart') opts.restartServer = false;
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

if (import.meta.main) {
  const { spawnSync } = await import('node:child_process');
  const { homedir } = await import('node:os');
  const { fly } = await import('../project-machine/mac-ops.ts');
  const { macOutputs } = await import('../project-machine/mac-outputs.ts');
  const { readMachines } = await import('../project-machine/machines.ts');
  const { readKeychainPassword } = await import('../../packages/server/src/share/keychain.ts');
  try {
    const opts = parseArgs(process.argv.slice(2));
    opts.homeRemotes ??= process.env.CW_HOME_REMOTES_FILE?.trim() || undefined;
    const code = await runInstall(opts, {
      home: homedir(),
      uid: process.getuid?.() ?? 501,
      seatsText: readFileSync(join(import.meta.dir, 'seats.json'), 'utf8'),
      projects: readMachines().map((m) => m.project),
      outputs: () => macOutputs('prod'),
      fetch: (url, init) => fetch(url, init),
      fly: (args, input) => fly(args, { input }),
      launchctl: (args) => {
        const r = spawnSync('launchctl', args, { encoding: 'utf8' });
        return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      },
      keychain: (service) => readKeychainPassword(service),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      out: (line) => console.log(line),
    });
    process.exit(code);
  } catch (e) {
    console.error(`[relay:install] ${(e as Error).message}`);
    process.exit(1);
  }
}
