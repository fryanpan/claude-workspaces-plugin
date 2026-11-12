#!/usr/bin/env bun
/**
 * `bun run cf:rotate-token "<name>"`: a new secret for one existing Access
 * service token, through the keeper on one passkey tap
 * (`packages/server/src/keeper/keeper-rotate.ts`). For a token whose secret
 * nobody holds. The token keeps its id and client id, so Terraform sees no
 * change; the old secret keeps working for 24 hours. A second rotation
 * inside those 24 hours ends the old secret at once, so the command says so.
 *
 * The new pair goes into the Keychain over the old one, under the services
 * a new token's pair uses (`service-tokens.ts` `tokenServices`), and is never
 * printed or written to a file.
 */
import {
  announceToBoard,
  boardUrlFromEnv,
} from '../../packages/server/src/keeper/keeper-announce.ts';
import { keeperHeld } from '../../packages/server/src/keeper/keeper-client.ts';
import type { CloudflareResult } from '../../packages/server/src/keeper/keeper-requests.ts';
import { type TokenServices, replaceTokenInKeychain, tokenServices } from './service-tokens.ts';

export interface RotateIo {
  /** The held rotation; resolves once the owner approved or denied. */
  rotate: (name: string) => Promise<CloudflareResult>;
  replaceToken: (services: TokenServices, clientId: string, secret: string) => void;
  out: (s: string) => void;
  err: (s: string) => void;
}

/** Exit code: 0 once the new pair is in the Keychain. */
export async function rotateToken(name: string, io: RotateIo): Promise<number> {
  let services: TokenServices;
  try {
    services = tokenServices(name);
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 2;
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
    io.err(`${answer.error ?? `the keeper answered ${r.status}`}\n`);
    return 1;
  }
  try {
    if (typeof answer.clientId !== 'string' || typeof answer.secret !== 'string') throw new Error();
    io.replaceToken(services, answer.clientId, answer.secret);
  } catch {
    // Never the caught message: it was raised next to the secret.
    io.err(
      `Rotated "${name}" but could not store the new secret in ${services.secret}; it is lost. Run this again for another one.\n`,
    );
    return 1;
  }
  io.out(
    `Rotated "${name}"; the new pair is in ${services.clientId} and ${services.secret}. The old secret works until ${String(answer.previousSecretExpiresAt)}. Do not rotate it again before then: a second rotation ends the old secret at once, and anything still using it stops signing in.\n`,
  );
  return 0;
}

if (import.meta.main) {
  const name = process.argv[2] ?? '';
  const origin = process.env.CW_KEEPER_URL?.trim() ?? '';
  if (!name || !origin) {
    process.stderr.write(
      'usage: bun run cf:rotate-token "<service token name>", with CW_KEEPER_URL set\n',
    );
    process.exit(2);
  }
  const requester = process.env.FEEDBACK_AGENT_NAME?.trim() || 'cf:rotate-token';
  const code = await rotateToken(name, {
    rotate: (n) =>
      keeperHeld(
        origin,
        '/v1/service-token-rotate',
        { name: n },
        {
          requester,
          announce: announceToBoard(boardUrlFromEnv(), requester),
          onHeld: (held) => {
            process.stderr.write(`[keeper] ${held.summary} waits for Bryan's passkey\n`);
            process.stderr.write(`[keeper] approve at ${held.approveUrl}\n`);
          },
        },
      ),
    replaceToken: replaceTokenInKeychain,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  process.exit(code);
}
