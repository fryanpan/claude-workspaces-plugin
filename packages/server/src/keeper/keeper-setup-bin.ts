#!/usr/bin/env bun
/**
 * Finish the keeper's setup: `keeper-setup.ts`, run by Bryan as himself.
 * `scripts/keeper-install.sh` runs it as its last step; on its own:
 *
 *   cd /Users/cw-relay/keeper/app && /Users/cw-relay/keeper/bin/bun \
 *     packages/server/src/keeper/keeper-setup-bin.ts [--dry-run]
 *
 * It runs only from the keeper's installed release, which only the keeper's
 * user can change, never from a checkout an agent can write: this process
 * handles the new tokens. For the same reason its tools come from a PATH it
 * sets itself (the keeper's `bin`, then the system's) and their environment
 * is built from nothing but what they need, not copied from the shell.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { configuredHostFetch, fixedHostFetch } from '../outbound-fetch.ts';
import { runKeeperSetup } from './keeper-setup.ts';

const ROOT = '/Users/cw-relay/keeper';
const LABEL = 'com.fryanpan.claude-workspaces';

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--dry-run');
if (unknown.length) {
  console.error(`[keeper-setup] unknown argument ${unknown[0]}; the only one is --dry-run`);
  process.exit(2);
}
const releases = `${ROOT}/releases/`;
let here = '';
try {
  here = realpathSync(import.meta.dir);
} catch {}
if (!here.startsWith(releases)) {
  console.error(
    `[keeper-setup] run this from the keeper's release (${ROOT}/app), not from ${import.meta.dir}: ` +
      'a checkout is a folder agents can write.',
  );
  process.exit(2);
}

/** One line from the terminal with echo off; the value is never shown. */
async function readSecret(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const tty = { stdio: 'inherit' as const };
  spawnSync('/bin/stty', ['-echo'], tty);
  try {
    for await (const line of console) return line;
    return '';
  } finally {
    spawnSync('/bin/stty', ['echo'], tty);
    process.stdout.write('\n');
  }
}

/**
 * Cloudflare through the vendor guard; the keeper's own loopback origin, the
 * only other host this asks, through the configured-host guard as
 * `keeper-client.ts` does.
 */
const guardedFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const viaKeeper = url.hostname === 'localhost' && url.protocol === 'http:';
  return (viaKeeper ? configuredHostFetch([url.origin]) : fixedHostFetch)(input, init);
}) as typeof fetch;

const home = homedir();
const env = {
  PATH: `${join(ROOT, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: home,
  USER: userInfo().username,
  LOGNAME: userInfo().username,
  TERM: process.env.TERM ?? 'dumb',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
};
process.exit(
  await runKeeperSetup({
    root: ROOT,
    user: 'cw-relay',
    home,
    uid: process.getuid?.() ?? -1,
    label: LABEL,
    env,
    dryRun: args.includes('--dry-run'),
    fetch: guardedFetch,
    readSecret,
    print: (line) => console.log(line),
  }),
);
