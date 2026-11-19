#!/usr/bin/env bun
/**
 * `bun run cf:sync-config`: send prod's gitignored routing configs to CI and
 * start the apply. No keeper and no tap: Bryan's own `gh` login writes the
 * repository secrets, and a merge-free dispatch of cloudflare.yml on main
 * applies them (its environment has no reviewer).
 *
 *   CF_ROUTER_CONFIG       infra/board-router-worker/router.local.json (required)
 *   CF_SHARE_LINK_CONFIG   infra/share-link-worker/wrangler.local.toml, when present
 *
 * CF_ACCESS_CONFIG is not written. The Access email lists retire with Better
 * Auth (Bryan, 19 Nov 2026), so the secret keeps the value it has and this
 * command no longer moves who may sign in (docs/process/keeper.md, "Retired").
 *
 * The configs are checked the way a plan reads them (`staticVars`) before
 * anything is written. Each value goes to `gh secret set` on stdin: never an
 * argument, a file or a printed line.
 */
import { spawnSync } from 'node:child_process';
import { HANDOFF_REPO } from '../handoff/mac-store.ts';
import { configReader } from './run.ts';
import { CONFIG_ENV, CONFIG_PATHS, type ReadConfig, staticVars } from './vars.ts';

export const SYNCED = ['router', 'shareLink'] as const;

export interface SyncIo {
  read: ReadConfig;
  /** `gh <args>`, `input` on stdin; the exit status and stderr. */
  gh: (args: string[], input?: string) => { status: number; stderr: string };
  out: (s: string) => void;
  err: (s: string) => void;
}

/** Exit code: 0 once cloudflare.yml was started with the configs written. */
export function syncConfig(io: SyncIo): number {
  const paths = CONFIG_PATHS.prod;
  try {
    staticVars(io.read, paths);
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\nNothing was written.\n`);
    return 1;
  }
  const written: string[] = [];
  for (const key of SYNCED) {
    const text = io.read(paths[key]);
    if (text === null) {
      io.out(`${paths[key]} is not here; ${CONFIG_ENV[key]} keeps the value it has.\n`);
      continue;
    }
    const r = io.gh(['secret', 'set', CONFIG_ENV[key], '--repo', HANDOFF_REPO], text);
    if (r.status !== 0) {
      io.err(`gh secret set ${CONFIG_ENV[key]} failed: ${r.stderr.trim()}\n`);
      if (written.length > 0) io.err(`Already written: ${written.join(', ')}.\n`);
      return 1;
    }
    written.push(CONFIG_ENV[key]);
  }
  io.out(`Wrote ${written.join(', ')}. ${CONFIG_ENV.access} is not synced any more.\n`);
  const run = io.gh(['workflow', 'run', 'cloudflare.yml', '--repo', HANDOFF_REPO, '--ref', 'main']);
  if (run.status !== 0) {
    io.err(`gh workflow run cloudflare.yml failed: ${run.stderr.trim()}\n`);
    return 1;
  }
  io.out(
    'Started cloudflare.yml on main; its apply job applies the configs (gh run list --workflow cloudflare.yml).\n',
  );
  return 0;
}

if (import.meta.main) {
  process.exit(
    syncConfig({
      // The files, never a CI stand-in a shell happened to export.
      read: configReader({}),
      gh: (args, input) => {
        const r = spawnSync('gh', args, {
          encoding: 'utf8',
          ...(input === undefined ? {} : { input }),
        });
        return { status: r.status ?? 1, stderr: r.stderr ?? '' };
      },
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    }),
  );
}
