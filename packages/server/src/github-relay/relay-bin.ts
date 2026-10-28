#!/usr/bin/env bun
/**
 * The GitHub relay's process, run on the Mac beside the broker.
 *
 *   bun packages/server/src/github-relay/relay-bin.ts
 *
 * `CW_GITHUB_RELAY_CONFIG` names the config (`relay-config.ts`); unset, it is
 * `.claude/github-relay.local.json` at the repo root, which is gitignored.
 * `CW_GITHUB_RELAY_INTERVAL_MS` is the wait between passes (default 5000).
 * Each push key and service-token secret is read from the Keychain once, at
 * start. A refused config stops the process: the relay never runs on part of
 * a file.
 */
import { join } from 'node:path';
import { readKeychainPassword } from '../share/keychain.ts';
import { loadGithubRelayConfig } from './relay-config.ts';
import { createGithubRelay } from './relay.ts';

function fail(line: string): never {
  console.error(`[github-relay] ${line}`);
  process.exit(1);
}

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
const configPath =
  process.env.CW_GITHUB_RELAY_CONFIG?.trim() ||
  join(repoRoot, '.claude', 'github-relay.local.json');
const config = loadGithubRelayConfig(configPath, (service) => readKeychainPassword(service));
if ('error' in config) fail(`refusing to start: ${config.error}`);
const relay = createGithubRelay({ config });
const interval = Number(process.env.CW_GITHUB_RELAY_INTERVAL_MS) || 5_000;
console.error(`[github-relay] running: ${config.boards.length} board(s), broker ${config.broker}`);
for (;;) {
  await relay.pollOnce();
  await new Promise((resolve) => setTimeout(resolve, interval));
}
