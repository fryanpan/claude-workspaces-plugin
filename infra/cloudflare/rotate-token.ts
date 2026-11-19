#!/usr/bin/env bun
/**
 * A new secret for one existing Access service token, for a token whose
 * secret nobody holds. The token keeps its id and client id, so Terraform
 * sees no change; the old secret keeps working for 24 hours. A second
 * rotation inside those 24 hours ends the old secret at once, so the command
 * says so.
 *
 *   bun run cf:rotate-token "<name>"   on the Mac: dispatches
 *                                      cf-rotate-token.yml on main with Bryan's
 *                                      own `gh` login. No tap.
 *   rotate-token.ts --ci "<name>"      in that workflow, in `cloudflare-prod`:
 *                                      rotates with the apply token
 *                                      (`rotateServiceToken`, the function the
 *                                      keeper ran) and seals the new pair to
 *                                      the Mac (CW_HANDOFF_OUT,
 *                                      `infra/handoff/`).
 *
 * `bun run handoff:pull` then puts the pair into the Keychain over the old
 * one, under the services a new token's pair uses (`service-tokens.ts`
 * `tokenServices`). The secret is never printed, written unsealed, or put in
 * an argument.
 */
import { spawnSync } from 'node:child_process';
import {
  classifyRotate,
  rotateServiceToken,
} from '../../packages/server/src/provisioning/rotate.ts';
import { type HandoffSink, macSinkFromEnv, recipientKey } from '../handoff/items.ts';
import { HANDOFF_REPO } from '../handoff/mac-store.ts';

export const ROTATE_WORKFLOW = 'cf-rotate-token.yml';

export interface DispatchIo {
  /** `gh <args>`; the exit status and stderr. */
  gh: (args: string[]) => { status: number; stderr: string };
  out: (s: string) => void;
  err: (s: string) => void;
}

function checkName(name: string, err: (s: string) => void): boolean {
  const v = classifyRotate(name);
  if (v.kind === 'refused') {
    err(`"${name}": ${v.reason}\n`);
    return false;
  }
  return true;
}

/** The Mac's half. Exit code: 0 once the workflow was started. */
export function dispatchRotation(name: string, io: DispatchIo): number {
  if (!checkName(name, io.err)) return 2;
  const r = io.gh([
    'workflow',
    'run',
    ROTATE_WORKFLOW,
    '--repo',
    HANDOFF_REPO,
    '--ref',
    'main',
    '-f',
    `name=${name}`,
  ]);
  if (r.status !== 0) {
    io.err(`gh workflow run ${ROTATE_WORKFLOW} failed: ${r.stderr.trim()}\n`);
    return 1;
  }
  io.out(
    `Started ${ROTATE_WORKFLOW} for "${name}". When it has finished, bun run handoff:pull puts the new pair into the Keychain. Do not rotate it again within 24 hours: a second rotation ends the old secret at once.\n`,
  );
  return 0;
}

export interface RotateIo {
  rotate: (name: string) => Promise<{ status: number; body: string }>;
  sink: HandoffSink | null;
  macKey: () => string;
  out: (s: string) => void;
  err: (s: string) => void;
}

/** The workflow's half. Exit code: 0 once the new pair is sealed to the Mac. */
export async function rotateInCi(name: string, io: RotateIo): Promise<number> {
  if (!checkName(name, io.err)) return 2;
  if (!io.sink) {
    io.err(
      'CW_HANDOFF_OUT is not set: a rotated secret goes only to the Mac. Nothing was rotated.\n',
    );
    return 1;
  }
  // Before the rotation: a secret that cannot be sealed must not be made.
  let key: string;
  try {
    key = io.macKey();
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}. Nothing was rotated.\n`);
    return 1;
  }
  const r = await io.rotate(name);
  let answer: {
    error?: string;
    clientId?: unknown;
    secret?: unknown;
    previousSecretExpiresAt?: unknown;
  } = {};
  try {
    answer = JSON.parse(r.body);
  } catch {}
  if (r.status !== 200) {
    io.err(`${answer.error ?? `the rotation answered ${r.status}`}\n`);
    return 1;
  }
  try {
    if (typeof answer.clientId !== 'string' || typeof answer.secret !== 'string') throw new Error();
    io.sink.add({
      kind: 'service-token',
      name,
      clientId: answer.clientId,
      secret: answer.secret,
      replace: true,
    });
    io.sink.flush(key);
  } catch {
    // Never the caught message: it was raised next to the secret.
    io.err(`Rotated "${name}" but could not seal the new secret; it is lost. Run this again.\n`);
    return 1;
  }
  io.out(
    `Rotated "${name}" and sealed the new pair to the Mac. The old secret works until ${String(answer.previousSecretExpiresAt)}.\n`,
  );
  return 0;
}

/** Cloudflare's API with one token, in the shape `rotateServiceToken` calls. */
export function cloudflareCaller(token: string, fetchImpl: typeof fetch = fetch) {
  return async (method: string, path: string, body: string | undefined) => {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body }),
    });
    return { status: res.status, body: await res.text() };
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const ci = args.includes('--ci');
  const name = args.find((a) => a !== '--ci') ?? '';
  const out = (s: string) => process.stdout.write(s);
  const err = (s: string) => process.stderr.write(s);
  if (!name) {
    err('usage: bun run cf:rotate-token "<service token name>"\n');
    process.exit(2);
  }
  if (!ci) {
    process.exit(
      dispatchRotation(name, {
        gh: (a) => {
          const r = spawnSync('gh', a, { encoding: 'utf8' });
          return { status: r.status ?? 1, stderr: r.stderr ?? '' };
        },
        out,
        err,
      }),
    );
  }
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  const code = await rotateInCi(name, {
    rotate: (n) => {
      if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set');
      return rotateServiceToken(cloudflareCaller(token), n);
    },
    sink: macSinkFromEnv(process.env),
    macKey: () => recipientKey('mac'),
    out,
    err,
  });
  process.exit(code);
}
