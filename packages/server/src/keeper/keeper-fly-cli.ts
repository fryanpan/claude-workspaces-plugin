#!/usr/bin/env bun
/**
 * One `fly` call through the keeper, for a synchronous caller.
 *
 * `infra/project-machine/mac-ops.ts` runs `fly` with `spawnSync`, and a
 * held call can wait minutes for a tap, so it spawns this instead: the call
 * arrives on stdin as `{"args": [...], "input": "..."}`, the approval link is
 * printed to stderr (the caller's terminal), and the result is printed to
 * stdout as `{"status", "stdout", "stderr"}`.
 */
import { KEEPER_URL_ENV, keeperFly } from './keeper-client.ts';

const origin = process.env[KEEPER_URL_ENV]?.trim();
if (!origin) {
  console.error(`[keeper] ${KEEPER_URL_ENV} is not set`);
  process.exit(2);
}
const call = JSON.parse(await Bun.stdin.text()) as { args: string[]; input?: string };
const result = await keeperFly(origin, call.args, call.input, {
  requester: process.env.FEEDBACK_AGENT_NAME?.trim() || 'deploy script',
  onHeld: (held) => {
    console.error(`[keeper] ${held.hold} waits for Bryan's passkey: ${held.summary}`);
    console.error(`[keeper] approve at ${held.approveUrl}`);
  },
});
process.stdout.write(JSON.stringify(result));
