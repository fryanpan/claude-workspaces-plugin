#!/usr/bin/env bun
/**
 * Asks for one passkey that covers one board's whole move.
 *
 *   bun run machine:approve-move --board <id> --project <name>
 *
 * Run it on a machine that already has this commit's image, then run
 * `machine:wall-report` and `machine:move-board` within 30 minutes. The
 * approval page lists every step it covers (`keeper-move-steps.ts`). A deploy
 * and its secrets are taps of their own. It waits until the owner answers.
 */
import {
  announceToBoard,
  boardUrlFromEnv,
} from '../../packages/server/src/keeper/keeper-announce.ts';
import { KEEPER_URL_ENV, keeperMoveGrant } from '../../packages/server/src/keeper/keeper-client.ts';
import { projectConfig } from './deploy-plan.ts';

const args = process.argv.slice(2);
const at = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const board = at('board');
const project = at('project');
const origin = process.env[KEEPER_URL_ENV]?.trim();
if (!board || !project) {
  console.error('[approve-move] --board <id> --project <name> are required');
  process.exit(2);
}
if (!origin) {
  console.error(`[approve-move] ${KEEPER_URL_ENV} is not set, so there is no keeper to ask`);
  process.exit(2);
}
const { app } = projectConfig({ project, imageLabel: '0'.repeat(40) });
const requester = process.env.FEEDBACK_AGENT_NAME?.trim() || 'approve-move';
const result = await keeperMoveGrant(origin, app, board, {
  requester,
  announce: announceToBoard(boardUrlFromEnv(), requester),
  onHeld: (held) => {
    console.error(`[approve-move] waits for Bryan's passkey: ${held.summary}`);
    console.error(`[approve-move] approve at ${held.approveUrl}`);
  },
});
if (result.status !== 200) {
  console.error(`[approve-move] not approved: ${result.body}`);
  process.exit(1);
}
console.log(`[approve-move] approved: ${app}, board ${board}, for 30 minutes`);
