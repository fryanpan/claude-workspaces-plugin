#!/usr/bin/env bun
/**
 * The bound-file sync's process, run on the Mac for a board that moved to a
 * project machine (docs/process/project-machine.md, "Bound files after the
 * move").
 *
 *   bun packages/server/src/bound-file-sync/sync-bin.ts <config.json>
 *
 * One process per board. A config that says `"enabled": false`, or none at
 * all, starts nothing: the sync is off until a person turns it on. State
 * (marks and the renewed board token) goes in `CW_BOARD_SYNC_STATE_DIR`,
 * default `~/.claude/claude-workspaces/board-sync`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readKeychainPassword } from '../share/keychain.ts';
import { startBoardSync } from './board-sync.ts';
import { loadSyncConfig } from './sync-config.ts';

const log = (line: string) => console.error(`[board-sync] ${line}`);
const path = process.argv[2];
if (!path) {
  log('usage: sync-bin.ts <config.json>');
  process.exit(2);
}
const config = loadSyncConfig(path, (service) => readKeychainPassword(service));
if (config === null) {
  log(`${path} is not enabled; nothing to do`);
  process.exit(0);
}
if ('error' in config) {
  log(`refusing to start: ${config.error}`);
  process.exit(1);
}
const stateDir =
  process.env.CW_BOARD_SYNC_STATE_DIR?.trim() ||
  join(homedir(), '.claude', 'claude-workspaces', 'board-sync');
const sync = startBoardSync({ config, stateDir, log });
log(`running: ${config.docs.length} file(s) on ${config.workspaceId} at ${config.baseUrl}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    sync.stop();
    process.exit(0);
  });
}
