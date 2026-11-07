/**
 * One step that moves a project's lead to another listed token.
 *
 * `fly secrets import` without `--stage` sets the token and its marker in one
 * call and restarts the machine on them, so the lead cannot run on the new
 * token with the old marker. Through the keeper the import is a `token.move`
 * hold, one passkey tap. The restart takes the board down for as long as a
 * boot takes, and the lead resumes its conversation (`lead.sh`).
 *
 * The move then waits on the machine until `lead.sh` has written the new
 * label, which it can only have from an entrypoint that accepted the marker,
 * so it shows the lead started on this token. That wait is one `fly ssh
 * console`, a second tap through the keeper, and runs in one shell on the
 * machine so waiting costs no more taps.
 *
 * An image older than this code reads the listed marker as another org's and
 * starts no lead, so the move refuses it before changing anything.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import {
  LEAD_BOARD_SECRET,
  LEAD_TOKEN_ORG_SECRET,
  LEAD_TOKEN_SECRET,
  PROJECT_NAME,
} from './deploy-plan.ts';
import { machines } from './deploy.ts';
import { flyJson, flyOk, onMachine } from './mac-ops.ts';
import { chooseToken, readTokenList, tokenMarker } from './token-list.ts';
import { LEAD_ROOT, MACHINE_PATH, asLead } from './token-usage.ts';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const CONFIRMED = 'cw-token-label=';
/** How long the machine may take to boot its lead, 2s a try. */
const CONFIRM_TRIES = 60;

/** Whether the image built from `commit` holds this code. An unknown commit does not. */
export function imageHasTokenList(commit: string, repo = REPO): boolean {
  if (!/^[0-9a-f]{40}$/.test(commit)) return false;
  const path = `${commit}:infra/project-machine/token-list.ts`;
  return spawnSync('git', ['-C', repo, 'cat-file', '-e', path], { stdio: 'ignore' }).status === 0;
}

export const waitForLabelCommand = (
  label: string,
  root = LEAD_ROOT,
  path = MACHINE_PATH,
): string => {
  const read = `$(cat ${root}/token-label 2>/dev/null)`;
  return asLead(
    `i=0; while [ $i -lt ${CONFIRM_TRIES} ]; do [ "${read}" = "${label}" ] && break; i=$((i + 1)); sleep 2; done; echo ${CONFIRMED}${read}`,
    path,
  );
};

export interface MoveResult {
  project: string;
  label: string;
  confirmed: boolean;
}

export function moveProject(
  project: string,
  label: string,
  opts: { imageReady?: (commit: string) => boolean } = {},
): MoveResult {
  if (!PROJECT_NAME.test(project)) throw new Error(`${project} is not a project name`);
  const target = chooseToken(readTokenList(), label);
  if (!target) throw new Error(`no token labelled ${label} is on the list; nothing was changed`);
  const app = `cw-${project}`;
  const secrets = flyJson<{ Name?: string; name?: string }[]>(['secrets', 'list', '--app', app]);
  if (!secrets.some((s) => (s.Name ?? s.name) === LEAD_BOARD_SECRET)) {
    throw new Error(`${app} has no lead to move: it holds no ${LEAD_BOARD_SECRET}`);
  }
  const running = machines(app).filter((m) => m.state !== 'destroyed');
  const ready = opts.imageReady ?? imageHasTokenList;
  if (running.length === 0 || running.some((m) => !ready(m.imageTag))) {
    throw new Error(
      `${app} runs an image that cannot start a lead on a listed token; run bun run machine:deploy --project ${project} first. Nothing was changed.`,
    );
  }
  const marker = tokenMarker(project, label, target.token);
  flyOk(['secrets', 'import', '--app', app], {
    input: `${LEAD_TOKEN_SECRET}=${target.token}\n${LEAD_TOKEN_ORG_SECRET}=${marker}\n`,
  });
  let confirmed = false;
  try {
    confirmed = onMachine(app, waitForLabelCommand(label))
      .split(/\r?\n/)
      .includes(`${CONFIRMED}${label}`);
  } catch {
    // The token is set; the caller reports that the lead was not confirmed.
  }
  return { project, label, confirmed };
}
