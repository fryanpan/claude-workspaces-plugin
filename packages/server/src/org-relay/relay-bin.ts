#!/usr/bin/env bun
/**
 * The relay's process.
 *
 *   bun packages/server/src/org-relay/relay-bin.ts             run: read every outbox on a timer
 *   bun packages/server/src/org-relay/relay-bin.ts held        list the hold queue
 *   bun packages/server/src/org-relay/relay-bin.ts release <id> deliver one held message
 *
 * `CW_RELAY_CONFIG` names the config (mode 600, `relay-config.ts`);
 * `CW_RELAY_STATE_DIR` the directory for the log, the hold queue and the
 * board tokens the relay renewed (`relay-bearers.ts`);
 * `CW_RELAY_INTERVAL_MS` the wait between passes (default 5000). A refused
 * config stops the process: the relay never runs on part of a file.
 */
import { applySavedBearers } from './relay-bearers.ts';
import { loadRelayConfig } from './relay-config.ts';
import { haikuRelayFilter } from './relay-filter.ts';
import { createRelayStore } from './relay-log.ts';
import { createRelay } from './relay.ts';

function fail(line: string): never {
  console.error(`[relay] ${line}`);
  process.exit(1);
}

const configPath = process.env.CW_RELAY_CONFIG?.trim() || fail('CW_RELAY_CONFIG is not set');
const stateDir = process.env.CW_RELAY_STATE_DIR?.trim() || fail('CW_RELAY_STATE_DIR is not set');
const config = loadRelayConfig(configPath);
if ('error' in config) fail(`refusing to start: ${config.error}`);
const store = createRelayStore(stateDir);
// Board tokens the relay renewed since the config was written.
applySavedBearers(config, stateDir);
const [command, arg] = process.argv.slice(2);
// A release delivers a message Bryan already judged, so only a run needs
// the classifier and only a run resolves its key.
const filter = command === undefined ? haikuRelayFilter() : null;
if (command === undefined && !filter) {
  console.error('[relay] no classifier key: every filtered message will be held');
}
const relay = createRelay({ config, store, filter, stateDir });

if (command === 'held') {
  for (const h of store.pending()) {
    console.log(`${h.id}\t${h.from} -> ${h.to}\t${h.reason}\n${h.text}\n`);
  }
} else if (command === 'release') {
  if (!arg) fail('release needs a message id');
  const result = await relay.release(arg);
  console.log(result);
  if (result !== 'released') process.exit(1);
} else if (command === undefined) {
  const interval = Number(process.env.CW_RELAY_INTERVAL_MS) || 5_000;
  console.error(`[relay] running: ${config.seats.size} seats on ${config.servers.size} servers`);
  for (;;) {
    await relay.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
} else {
  fail(`unknown command "${command}"`);
}
